#!/usr/bin/env bash
# OPS-SEED-ORCHESTRATOR-W1 CH4 — 48h post-cutover coverage + connection gate.
#
# Host-side monitoring script. Installed to /opt/algovault-monitoring/ via SSH
# (ops/monitoring/** is paths-ignored from deploy — no container restart). Armed as a
# ONE-SHOT TRANSIENT timer (mirrors shadow-cpu-gate-48h / OPS-SHADOW-PIPELINE-W1 V2):
#   systemd-run --on-active=48h --unit=seed-orchestrator-gate-48h \
#     /opt/algovault-monitoring/seed-orchestrator-gate-48h.sh
#
# Verifies the per-timeframe seed orchestrator (BINANCE/BYBIT/OKX/BITGET consolidated via
# --exchange-list; HL kept on its own legacy line by design) held seeding COVERAGE and
# BOUNDED connections 48h after the 5m..1d cutover. Classifies G/Y/R vs the CH3 baseline
# (FLOOR semantics, per-venue, never absolute — HL is intrinsically sparse). On RED posts an
# operator-action-required Telegram via send_telegram.sh (CRITICAL_PERSISTENT). FAIL-OPEN:
# always exits 0; forensic to journal; alert ONLY on sustained RED; NO TG on G/Y
# (silent-success contract, CLAUDE.md ## Automation-first recovery).
#
# Test hooks: SMOKE=1 or FORCE_CLASS=R overrides the verdict (exercise the DRY_RUN_TG path);
# DRY_RUN_TG=1 makes send_telegram.sh log DRY_RUN_FIRED instead of sending.
#
# ROLLBACK (full un-migrate — restore all-legacy crontab, drops orchestrator + reaper):
#   bash /opt/algovault-monitoring/seed-orchestrator-crontab.sh --revert /opt/crontab.bak-20260607T022834Z
#   systemctl stop seed-orchestrator-gate-48h.timer 2>/dev/null; systemctl stop seed-orchestrator-gate-48h-rearm.timer 2>/dev/null
set -uo pipefail

TS=$(date -u +%FT%TZ)
PSQL=(docker exec crypto-quant-signal-mcp-postgres-1 psql -U algovault -d signal_performance -tAc)
WRAP=/opt/algovault-monitoring/send_telegram.sh
BASELINE=/opt/algovault-monitoring/OPS-SEED-ORCHESTRATOR-W1-baseline.json
ROLLBACK_BACKUP=/opt/crontab.bak-20260607T022834Z
STATE_REARM=/opt/algovault-monitoring/.seed-orch-gate-rearmed
LOGDIR=/var/log
PROMOTED="BINANCE BITGET BYBIT HL OKX"
FAST=" BINANCE BITGET BYBIT OKX "        # padded for whole-word membership test
declare -A CAD=( [5m]=300 [15m]=900 [30m]=1800 [1h]=3600 [2h]=7200 [4h]=14400 [8h]=28800 [12h]=43200 [1d]=86400 )
MIG_TFS="5m 15m 30m 1h 2h 4h 8h 12h 1d"

q() { "${PSQL[@]}" "$1" 2>/dev/null; }

reasons_R=(); reasons_Y=()
peak=0; rate=0; total=0

NOW=$(q "SELECT extract(epoch from now())::bigint"); NOW=${NOW:-0}

# --- [1] per-venue 24h signal count vs baseline FLOOR (0.8x = R-below-0.6x / Y-in-band) ---
# signals.created_at is epoch SECONDS. FLOOR-relative per venue (HL sparse → never absolute).
if [ -r "$BASELINE" ]; then
  for v in $PROMOTED; do
    cnt=$(q "SELECT count(*) FROM signals WHERE exchange='$v' AND created_at >= extract(epoch from now())::bigint - 86400"); cnt=${cnt:--1}
    base=$(jq -r --arg v "$v" '.by_venue_total_24h[$v] // 0' "$BASELINE" 2>/dev/null || echo 0)
    floor=$(jq -r --arg v "$v" '.floor_0_8x_by_venue_total[$v] // 0' "$BASELINE" 2>/dev/null || echo 0)
    band60=$(awk -v b="$base" 'BEGIN{printf "%d", b*0.6}')
    if [ "$cnt" -lt 0 ]; then reasons_Y+=("$v count query failed"); continue; fi
    if   [ "$cnt" -lt "$band60" ]; then reasons_R+=("$v 24h=$cnt < 0.6x base $base")
    elif [ "$cnt" -lt "$floor" ];  then reasons_Y+=("$v 24h=$cnt in [0.6x,0.8x) (floor $floor)")
    fi
  done
else
  reasons_Y+=("baseline JSON unreadable at $BASELINE")
fi

# --- [2] pg_stat_activity spot-peak (10 samples / ~20s): R>=80, Y in [60,80) ---
for _ in $(seq 1 10); do
  n=$(q "SELECT count(*) FROM pg_stat_activity"); n=${n:-0}
  [ "$n" -gt "$peak" ] && peak=$n
  sleep 2
done
if   [ "$peak" -ge 80 ]; then reasons_R+=("pg spot-peak $peak >= 80")
elif [ "$peak" -ge 60 ]; then reasons_Y+=("pg spot-peak $peak in [60,80)")
fi

# --- [3] overrun rate + streak over the soak (orchestrator summary lines) ---
over=0; maxstreak=0
for tf in $MIG_TFS; do
  log="$LOGDIR/seed-orch-$tf.log"; [ -f "$log" ] || continue
  streak=0
  while IFS= read -r line; do
    total=$((total+1))
    if printf '%s' "$line" | grep -q 'overrun=true'; then
      over=$((over+1)); streak=$((streak+1)); [ "$streak" -gt "$maxstreak" ] && maxstreak=$streak
    else streak=0; fi
  done < <(grep "\[seed-orchestrator\] tf=$tf " "$log" 2>/dev/null)
done
[ "$total" -gt 0 ] && rate=$(awk -v o="$over" -v t="$total" 'BEGIN{printf "%d",(o*100)/t}')
if   [ "$maxstreak" -ge 3 ] || [ "$rate" -ge 20 ]; then reasons_R+=("overrun streak=$maxstreak rate=${rate}%/$total")
elif [ "$rate" -ge 5 ]; then reasons_Y+=("overrun rate ${rate}%/$total")
fi

# --- [4] seed_heartbeats lag per (migrated TF x promoted venue): R>6h (fast), Y>2x cadence ---
for tf in $MIG_TFS; do
  cad=${CAD[$tf]}; lag2=$((cad*2))
  for v in $PROMOTED; do
    la=$(q "SELECT last_attempt_at FROM seed_heartbeats WHERE exchange='$v' AND timeframe='$tf'")
    [ -z "$la" ] && continue   # (venue,tf) never attempted — sparse, not an error
    lag=$(( NOW - la ))
    if [ "$lag" -gt 21600 ] && [ "${FAST/ $v /}" != "$FAST" ]; then
      reasons_R+=("$v $tf hb-lag ${lag}s > 6h")
    elif [ "$lag" -gt "$lag2" ]; then
      reasons_Y+=("$v $tf hb-lag ${lag}s > 2x cad ${lag2}s")
    fi
  done
done

# --- [5] sustained report-only staleness findings in monitor log (A3, informational) ---
stale=$(grep -c 'seed-freshness (report-only' "$LOGDIR/monitor.log" 2>/dev/null || true); stale=${stale:-0}
[ "$stale" -ge 20 ] && reasons_Y+=("$stale report-only staleness findings")

# --- classify (R > Y > G) ---
if   [ "${#reasons_R[@]}" -gt 0 ]; then CLASS=R
elif [ "${#reasons_Y[@]}" -gt 0 ]; then CLASS=Y
else CLASS=G; fi
# Test hooks (smoke the alert plumbing without a real regression)
[ "${SMOKE:-0}" = "1" ] && { CLASS=R; reasons_R=("SMOKE TEST — synthetic RED to exercise DRY_RUN_TG"); }
[ -n "${FORCE_CLASS:-}" ] && CLASS="$FORCE_CLASS"

echo "[$TS] seed-orchestrator-gate-48h class=$CLASS pg_peak=$peak overrun=${rate}%/$total R=[${reasons_R[*]:-none}] Y=[${reasons_Y[*]:-none}]"

case "$CLASS" in
  G)
    echo "[$TS] GREEN — coverage >= 0.8x floor all venues, pg<60, overrun<5%, heartbeats fresh. Silent success (NO TG)."
    ;;
  Y)
    if [ ! -f "$STATE_REARM" ]; then
      touch "$STATE_REARM"
      if systemd-run --on-active=48h --unit=seed-orchestrator-gate-48h-rearm /opt/algovault-monitoring/seed-orchestrator-gate-48h.sh >/dev/null 2>&1; then
        echo "[$TS] YELLOW — re-armed once (+48h). Reasons: ${reasons_Y[*]}"
      else
        echo "[$TS] YELLOW — re-arm scheduling FAILED (manual review). Reasons: ${reasons_Y[*]}"
      fi
    else
      echo "[$TS] YELLOW persists after re-arm — log-only, operator review. Reasons: ${reasons_Y[*]}"
    fi
    ;;
  R)
    MSG="🔴 OPS-SEED-ORCHESTRATOR-W1 48h gate RED — seed orchestrator coverage/connection regression.
Conditions: ${reasons_R[*]}.
pg spot-peak ${peak}; overrun ${rate}% of ${total} fires.
Trajectory: 48h after the 5m..1d cutover (BINANCE/BYBIT/OKX/BITGET via --exchange-list; HL on its own line).
Action: dispatch OPS-SEED-ORCHESTRATOR-W{NEXT} via Cowork -> Claude Code.
Audit: audits/OPS-SEED-ORCHESTRATOR-W1-*. Logs: /var/log/seed-orch-*.log + /var/log/seed-orch-reap.log.
Rollback: bash /opt/algovault-monitoring/seed-orchestrator-crontab.sh --revert ${ROLLBACK_BACKUP} && systemctl stop seed-orchestrator-gate-48h.timer"
    if [ -x "$WRAP" ]; then
      "$WRAP" SEED_ORCHESTRATOR_GATE_RED CRITICAL_PERSISTENT - <<<"$MSG" || echo "[$TS] WARN send_telegram.sh nonzero"
    else
      echo "[$TS] WARN send_telegram.sh missing at $WRAP"
    fi
    ;;
esac
exit 0
