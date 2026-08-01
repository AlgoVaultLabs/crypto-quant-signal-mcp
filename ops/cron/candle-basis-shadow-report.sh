#!/usr/bin/env bash
# candle-basis-shadow-report.sh — SIGNAL-CLOSEDBAR-SHADOW-W1 CH7
#
# Daily host wrapper for the READ-ONLY closed-bar divergence reporter. Cron invokes THIS
# file directly from the deploy checkout (`ops/cron/**` is NOT in deploy.yml's paths-ignore
# precisely because these wrappers are read from the host checkout, not baked into the
# image). It is deliberately NOT copied into /opt/algovault-monitoring/ — a second copy
# would drift from its repo ancestor on every deploy and trip HASH_DRIFT / DIVERGENT_COPY.
#
# ── Why the report is written HERE and not by the reporter ───────────────────
# The reporter runs INSIDE the app container and must never write there: `docker compose
# up -d` destroys the container filesystem on every deploy, and the ≥7-day series IS the
# deliverable. It must not write into the repo's audits/ either — that path is NOT in
# paths-ignore and IS COPYd by the Dockerfile, so a daily artifact would force a prod
# rebuild every morning. So the reporter writes only to stdout and this wrapper persists.
#
# ── seeded_tfs is derived LIVE, never from a table ───────────────────────────
# Readiness is per-timeframe and the SEEDED set lives in the root crontab, which the
# container cannot read. Three different "live" sets exist (SUPPORTED / EXPOSED / SEEDED),
# so a hardcoded list would silently encode the wrong one — and it would already be wrong:
# the wave spec recorded SEEDED=9 "no 1m/3m", but the live crontab carries a `3m` seeder
# (`2-59/3 * * * *`), making it 10. Deriving beats transcribing.
#
# Alerts go through the shared send_telegram.sh, which owns cooldown / severity / fail-open.
# This wrapper never re-implements those gates. Only two conditions are operator-actionable:
#   CANDLE_BASIS_FLIP_READY   — once EVER (send_telegram's cooldown is 24h, not once-ever)
#   CANDLE_BASIS_SHADOW_STALLED — n has not grown in 48h, i.e. the shadow write went dark
set -uo pipefail

STATE_DIR=/var/lib/algovault-candle-basis
CTR=crypto-quant-signal-mcp-mcp-server-1
REPORTER=/app/dist/scripts/candle-basis-measure.js
TG=/opt/algovault-monitoring/send_telegram.sh
STATE="$STATE_DIR/state.json"
FLIP_MARKER="$STATE_DIR/.flip-ready.fired"
STALL_SECONDS=$((48 * 3600))
TODAY=$(date -u +%Y-%m-%d)
NOW_EPOCH=$(date -u +%s)

mkdir -p "$STATE_DIR"

# Timeframes with a live seed-signals cron. `--timeframe 5m` and `--timeframe=5m` both match.
SEEDED=$(crontab -l 2>/dev/null \
  | grep 'seed-signals' \
  | grep -oE -- '--timeframe[= ][^ ]+' \
  | sed -E 's/--timeframe[= ]//' \
  | sort -u | paste -sd, -)

if [ -z "$SEEDED" ]; then
  # Never fall back to a hardcoded set: an empty derivation means the crontab changed shape,
  # and a guessed list would produce a confident, wrong readiness verdict.
  echo "CANDLE_BASIS_FLIP_NOT_READY: seeded_tfs_not_supplied (no seed-signals cron matched)"
  exit 0
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/candle-basis.XXXXXX") || exit 0
trap 'rm -rf "$TMP"' EXIT

docker exec "$CTR" node "$REPORTER" --seeded-tfs="$SEEDED" > "$TMP/report.md" 2>"$TMP/md.err"
MD_RC=$?
docker exec "$CTR" node "$REPORTER" --seeded-tfs="$SEEDED" --format=json > "$TMP/report.raw" 2>"$TMP/json.err"
JSON_RC=$?

if [ "$MD_RC" -ne 0 ] || [ "$JSON_RC" -ne 0 ]; then
  echo "CANDLE_BASIS_REPORT_FAILED md_rc=$MD_RC json_rc=$JSON_RC"
  head -5 "$TMP/md.err" "$TMP/json.err" 2>/dev/null
  exit 1
fi

# The reporter's contract: body first, VERDICT LINE ALWAYS LAST, in both formats. So the
# JSON payload is everything except that last line.
VERDICT=$(tail -1 "$TMP/report.raw")
sed '$d' "$TMP/report.raw" > "$TMP/report.json"

install -m 0644 "$TMP/report.md"   "$STATE_DIR/report-$TODAY.md"
install -m 0644 "$TMP/report.json" "$STATE_DIR/report-$TODAY.json"

N=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('n_rows',0))" "$TMP/report.json" 2>/dev/null || echo 0)

# state.json carries the PREVIOUS run's n and when n last grew — without that stored value
# there is no way to detect a stalled shadow at all.
PREV_N=0
LAST_GROWTH=$NOW_EPOCH
if [ -f "$STATE" ]; then
  PREV_N=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('last_n',0))" "$STATE" 2>/dev/null || echo 0)
  LAST_GROWTH=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('last_growth_epoch',0))" "$STATE" 2>/dev/null || echo "$NOW_EPOCH")
fi
if [ "$N" -gt "$PREV_N" ]; then LAST_GROWTH=$NOW_EPOCH; fi

python3 - "$STATE" "$N" "$LAST_GROWTH" "$NOW_EPOCH" "$VERDICT" <<'PY'
import json, sys
path, n, growth, now, verdict = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
json.dump({"last_n": n, "last_growth_epoch": growth, "last_run_epoch": now,
           "last_verdict": verdict}, open(path, "w"), indent=1)
PY

STALLED_FOR=$((NOW_EPOCH - LAST_GROWTH))

# ── Operator-action-required alerts ONLY ────────────────────────────────────
case "$VERDICT" in
  CANDLE_BASIS_FLIP_READY*)
    if [ ! -f "$FLIP_MARKER" ]; then
      printf '✅ CANDLE_BASIS_FLIP_READY\n\nThe closed-bar shadow window has met its evidence bar.\n\n%s\n\nseeded_tfs (derived live from crontab): %s\nReport: %s\nRunbook: docs/RUNBOOK-CANDLE-BASIS-FLIP.md\n\nAction: dispatch SIGNAL-CLOSEDBAR-FLIP-W{NEXT} via Cowork → Claude Code\n' \
        "$VERDICT" "$SEEDED" "$STATE_DIR/report-$TODAY.md" \
        | "$TG" "CANDLE_BASIS_FLIP_READY" CRITICAL_PERSISTENT - && touch "$FLIP_MARKER"
    fi
    ;;
esac

if [ "$STALLED_FOR" -gt "$STALL_SECONDS" ]; then
  printf '🛑 CANDLE_BASIS_SHADOW_STALLED\n\ncandle_basis_shadow row count has not grown in %sh (n=%s, unchanged since the recorded growth stamp). The shadow write is likely DARK — the ≥7d window is not accumulating.\n\nReport: %s\n\nAction: dispatch SIGNAL-CLOSEDBAR-FLIP-W{NEXT} via Cowork → Claude Code\n' \
    "$((STALLED_FOR / 3600))" "$N" "$STATE_DIR/report-$TODAY.md" \
    | "$TG" "CANDLE_BASIS_SHADOW_STALLED" CRITICAL_PERSISTENT -
fi

# Positive, greppable evidence that this run actually evaluated something, and the verdict
# LAST so the gate (and a human) can `tail -1` it.
echo "candle-basis-report: date=$TODAY n_rows=$N prev_n=$PREV_N seeded_tfs=$SEEDED stalled_for_h=$((STALLED_FOR / 3600))"
echo "candle-basis-report: wrote $STATE_DIR/report-$TODAY.md and report-$TODAY.json"
echo "$VERDICT"
