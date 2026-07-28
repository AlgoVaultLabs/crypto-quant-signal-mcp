#!/usr/bin/env bash
#
# /opt/algovault-monitoring/postgres-cpu-snapshot.sh
#
# OPS-POSTGRES-RECAUDIT-W1 (2026-05-22) — closes the silent-monitoring-drift
# gap that allowed postgres CPU to drift 33× over 22 days (1% → 33%) without
# any alert firing. Logs a postgres-CPU sample to a tiny audit log every 6h
# (4 samples/day × 7d = 28 samples in the rolling window); warns to stderr
# if the 7-day rolling average climbs above 2× the post-optimization
# baseline (default 10% → 20% threshold).
#
# OPS-MONITORING-TELEGRAM-INTEGRATION-W1 (2026-05-23) — wires 2 alert
# branches to /opt/algovault-monitoring/send_telegram.sh. Fires TG ONLY
# when conditions meet the operator-action-required contract (see
# CLAUDE.md ## Automation-first recovery → "Operator-action-required
# alert contract"). Single-sample spikes continue to log silently;
# only sustained drift (7d avg > 20%) and 3-consecutive-samples-over-50%
# trajectories alert via TG.
#
# Cron schedule: `0 */6 * * * /opt/algovault-monitoring/postgres-cpu-snapshot.sh`
# Log rotation: weekly, 8-rotate, gzip — see /etc/logrotate.d/postgres-cpu-snapshot
set -euo pipefail

LOG="${LOG_FILE_OVERRIDE:-/var/log/postgres-cpu-snapshot.log}"
BASELINE_PCT=10
THRESHOLD_PCT=$((BASELINE_PCT * 2))
CONTAINER=crypto-quant-signal-mcp-postgres-1

# Take 5 samples 1s apart and use the median to filter momentary spikes / dips
SAMPLES=()
for _ in $(seq 1 30); do
  S=$(docker stats --no-stream --format '{{.CPUPerc}}' "$CONTAINER" 2>/dev/null | tr -d '%' || echo "0")
  SAMPLES+=("$S")
  sleep 1
done
MEDIAN=$(printf '%s\n' "${SAMPLES[@]}" | sort -n | awk 'NR==15{print; exit}')

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "$TS $MEDIAN" >> "$LOG"

# 7-day rolling average (28 samples max @ every-6h cadence; tail trims older).
# awk handles empty file gracefully. WARNING lines have $2="WARNING" which
# coerces to 0 → slight under-estimation bias; preserved for calibration
# consistency with OPS-POSTGRES-RECAUDIT-W1.
AVG=$(tail -28 "$LOG" 2>/dev/null | awk '{sum+=$2; n++} END {if (n>0) printf "%.2f", sum/n; else print "0.00"}')

# Above-threshold WARNING — fires when 7d rolling avg > 2× baseline.
# Uses awk for floating-point compare (bash arithmetic is integer-only).
if awk -v avg="$AVG" -v t="$THRESHOLD_PCT" 'BEGIN{exit !(avg > t)}'; then
  echo "POSTGRES_CPU_DRIFT WARNING ${TS}: 7d rolling avg ${AVG}% > ${THRESHOLD_PCT}% (2× baseline ${BASELINE_PCT}%)" >&2
  echo "POSTGRES_CPU_DRIFT WARNING ${TS}: 7d rolling avg ${AVG}% > ${THRESHOLD_PCT}% (2× baseline ${BASELINE_PCT}%)" >> "$LOG"
fi

# === OPS-POSTGRES-AUTOPILOT-UNIFIED-W1 (2026-05-27): unified Condition 1+2 routing ===
# BOTH triggers (rolling-avg > BASELINE_PCT AND/OR last-3-all > 50%) now flow through
# autopilot Detect → Classify → Recover → Verify → Escalate state machine in ONE invocation.
# Single POSTGRES_CPU_DRIFT_UNIFIED alert_id + 24h cooldown prevents 2-alert noise on
# overlapping triggers. --trigger flag passes through to autopilot's log + body for observability.

NUMERIC_TAIL_28="$(tail -28 "$LOG" 2>/dev/null | grep -E '^[0-9]' || true)"
SAMPLES_28=$(echo "$NUMERIC_TAIL_28" | grep -c . || echo "0")
ABOVE_20=$(echo "$NUMERIC_TAIL_28" | awk '$2 > 20 {c++} END {print c+0}')

# Build TRIGGER from BOTH conditions:
#   TRIGGER_PERSISTENT: rolling avg > BASELINE_PCT (= 10%)
#   TRIGGER_TRAJECTORY: last-3 numeric samples all > 50%
TRIGGER_PERSISTENT=""
TRIGGER_TRAJECTORY=""
if awk -v a="$AVG" -v b="$BASELINE_PCT" 'BEGIN{exit !(a > b)}'; then
  TRIGGER_PERSISTENT="persistent"
fi
LAST_3_LINES="$(echo "$NUMERIC_TAIL_28" | tail -3)"
LAST_3_COUNT=$(echo "$LAST_3_LINES" | grep -c . || echo "0")
CONSEC_OVER_50=$(echo "$LAST_3_LINES" | awk '$2 > 50 {c++} END {print c+0}')
if [[ "$LAST_3_COUNT" == "3" && "$CONSEC_OVER_50" == "3" ]]; then
  TRIGGER_TRAJECTORY="trajectory"
fi
if [[ -n "$TRIGGER_PERSISTENT" && -n "$TRIGGER_TRAJECTORY" ]]; then
  TRIGGER="persistent_AND_trajectory"
elif [[ -n "$TRIGGER_PERSISTENT" ]]; then
  TRIGGER="persistent"
elif [[ -n "$TRIGGER_TRAJECTORY" ]]; then
  TRIGGER="trajectory"
else
  TRIGGER=""
fi

if [[ -n "$TRIGGER" ]]; then
  RECENT_SAMPLES=$(echo "$NUMERIC_TAIL_28" | awk '{print $2}' | tail -3 | tr '\n' ',' | sed 's/,$//')
  PEAK_SAMPLE=$(echo "$NUMERIC_TAIL_28" | awk '{print $2}' | sort -nr | head -1)
  if [ ! -x /opt/algovault-monitoring/postgres-cpu-autopilot.py ]; then
    AUTOPILOT_OUT="autopilot.py missing or not executable"; AUTOPILOT_EXIT=3
  else
    set +e
    AUTOPILOT_OUT=$(python3 /opt/algovault-monitoring/postgres-cpu-autopilot.py \
                      --trigger "$TRIGGER" \
                      --avg "$AVG" --peak "${PEAK_SAMPLE:-0}" --recent-samples "$RECENT_SAMPLES" 2>&1)
    AUTOPILOT_EXIT=$?
    set -e
  fi
  case "$AUTOPILOT_EXIT" in
    0) : ;;
    1) echo "$AUTOPILOT_OUT" | /opt/algovault-monitoring/send_telegram.sh "POSTGRES_CPU_DRIFT_UNIFIED" CRITICAL_PERSISTENT - ;;
    2) echo "CRITICAL_BYPASS: $AUTOPILOT_OUT" | /opt/algovault-monitoring/send_telegram.sh "POSTGRES_CPU_DRIFT_CRITICAL_BYPASS" CRITICAL_PERSISTENT - ;;
    *) printf '🛑 POSTGRES_CPU_DRIFT_UNIFIED [autopilot framework_error]\n\n7-day rolling avg: %s%% trigger=%s (baseline target: < 10%%, alert threshold: > 20%%)\n\nAction: dispatch OPS-POSTGRES-AUTOPILOT-UNIFIED-W{NEXT} via Cowork → Claude Code\nAudit shape: audits/OPS-POSTGRES-AUTOPILOT-UNIFIED-W1-endpoint-truth.md\n\nSnapshot log: %s\n' "$AVG" "$TRIGGER" "$LOG" | /opt/algovault-monitoring/send_telegram.sh "POSTGRES_CPU_DRIFT_UNIFIED" CRITICAL_PERSISTENT - ;;
  esac
fi
# === END OPS-POSTGRES-AUTOPILOT-UNIFIED-W1 unified routing ===
