#!/usr/bin/env bash
# OPS-SHADOW-PIPELINE-W1 / C3 — 48h post-cron CPU re-probe gate.
#
# Host-side monitoring script. Installed to /opt/algovault-monitoring/ via SSH
# (NOT shipped in the container image; ops/monitoring/** is paths-ignored from
# deploy). Scheduled as a one-shot transient timer:
#   systemd-run --on-active=48h --unit=shadow-cpu-gate-48h \
#     /opt/algovault-monitoring/shadow-cpu-gate-48h.sh
#
# Re-checks normalized CPU 48h after the 12-shadow-venue 15m seed cron was added
# (2026-06-01). Classifies G/Y/R; on RED posts an operator-action-required
# Telegram alert (rollback bash inline) via the send_telegram.sh wrapper
# (severity/cooldown/resolution delegated to the wrapper). Fail-open: always
# exits 0; forensic to journal, alert only on sustained RED.
#
# Rollback (restores the pre-add crontab, removing the shadow seed cron):
#   crontab /opt/crontab.bak-20260601T084505Z
set -uo pipefail
NPROC=$(nproc)
LOAD=$(awk '{print $2}' /proc/loadavg)            # 5-min load average
NORM=$(awk -v l="$LOAD" -v n="$NPROC" 'BEGIN{printf "%.0f",(l/n)*100}')
WRAP=/opt/algovault-monitoring/send_telegram.sh
TS=$(date -u +%FT%TZ)
if   [ "$NORM" -ge 70 ]; then CLASS=R
elif [ "$NORM" -ge 55 ]; then CLASS=Y
else CLASS=G; fi
echo "[$TS] shadow-cpu-gate-48h nproc=$NPROC load5=$LOAD normalized=${NORM}% class=$CLASS"
if [ "$CLASS" = "R" ]; then
  MSG="🔴 OPS-SHADOW-PIPELINE-W1 48h CPU gate RED — normalized CPU ${NORM}% (load5 ${LOAD} / ${NPROC} vCPU) after the 12 shadow-venue 15m seed cron. Options: (a) rollback the shadow seed cron, or (b) upgrade the box (CPX31 4vCPU ~24usd/mo). Rollback: crontab /opt/crontab.bak-20260601T084505Z. Recommended wave: OPS-CPU-W{NEXT}."
  if [ -x "$WRAP" ]; then "$WRAP" "$MSG" || echo "[$TS] WARN send_telegram.sh exit nonzero"; else echo "[$TS] WARN send_telegram.sh missing"; fi
fi
exit 0
