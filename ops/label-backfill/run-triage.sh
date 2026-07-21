#!/bin/bash
# OPS-DIRECTIONAL-LABEL-HALT-W1 R3 — triage-ordered directional-label backfill.
#
# Order = recoverability-fuse (expired-soonest first; matrix v1 2026-07-21):
#   T1  3.5–10.4d-fuse slices (3m/5m on WEEX/XT/HTX/PHEMEX; MEXC 3m/5m;
#       WHITEBIT 3m/5m/15m; WEEX 15m/30m; XT/HTX/PHEMEX 15m)
#   T2  20.8d-fuse slices (XT/HTX/PHEMEX 30m; MEXC 15m; WHITEBIT 30m)
#   T3  no-fuse full-venue sweeps (>=1h everywhere + KUCOIN/OKX/HL all —
#       DB-state resume makes already-done slices no-ops)
#
# Convergence loop per slice: the labeler is idempotent + DB-state-resumable;
# a container recreate mid-slice (the incident's killer) just means rerun.
# --check's would-write count includes permanently-unlabelable signals
# (expired klines), so "remaining == 0" is unreachable for expired cohorts —
# convergence = remaining STOPS DECREASING across attempts.
#
# Pacing: every kline fetch goes through the container's shared weight-budget
# batch lane (418/429 typed, never blind-retried) — the riders are inherited.
set -u
CTR=crypto-quant-signal-mcp-mcp-server-1
LOG=/var/log/label-backfill-triage.log
LOCK=/var/lock/algovault-label-backfill.lock
MAX_ATTEMPTS=6

exec 9>"$LOCK"
flock -n 9 || { echo "another triage run holds $LOCK — exiting" >&2; exit 1; }

log() { echo "$(date -u +%FT%TZ) [triage] $*" >> "$LOG"; }

check_remaining() { # venue [tf] → would-write count via --check (zero-write)
  local venue=$1 tf=${2:-}
  local flags=(--venue "$venue"); [ -n "$tf" ] && flags+=(--timeframe "$tf")
  docker exec "$CTR" node dist/scripts/backfill-directional-labels.js "${flags[@]}" --check 2>/dev/null \
    | grep -oE '"written":[0-9]+' | tail -1 | cut -d: -f2
}

run_slice() {
  local venue=$1 tf=${2:-}
  local flags=(--venue "$venue"); [ -n "$tf" ] && flags+=(--timeframe "$tf")
  local prev=-1 rem attempt
  for attempt in $(seq 1 $MAX_ATTEMPTS); do
    log "slice $venue ${tf:-ALL} attempt=$attempt START"
    docker exec "$CTR" node dist/scripts/backfill-directional-labels.js "${flags[@]}" >> "$LOG" 2>&1
    rem=$(check_remaining "$venue" "$tf"); rem=${rem:-ERR}
    log "slice $venue ${tf:-ALL} attempt=$attempt end remaining=$rem (prev=$prev)"
    if [ "$rem" = "ERR" ]; then continue; fi
    if [ "$rem" -eq 0 ] || [ "$rem" -eq "$prev" ]; then
      log "slice $venue ${tf:-ALL} CONVERGED remaining=$rem"
      return 0
    fi
    prev=$rem
  done
  log "slice $venue ${tf:-ALL} MAX_ATTEMPTS reached remaining=$rem — moving on (resumable)"
}

log "=== TRIAGE BACKFILL START ==="
# T1 — shortest fuse first
for s in "WEEX 3m" "WEEX 5m" "XT 3m" "XT 5m" "HTX 3m" "HTX 5m" "PHEMEX 3m" "PHEMEX 5m" \
         "MEXC 3m" "MEXC 5m" \
         "WHITEBIT 3m" "WHITEBIT 5m" "WHITEBIT 15m" "WEEX 15m" "WEEX 30m" \
         "XT 15m" "HTX 15m" "PHEMEX 15m"; do
  run_slice $s
done
log "=== T1 COMPLETE ==="
# T2
for s in "XT 30m" "HTX 30m" "PHEMEX 30m" "MEXC 15m" "WHITEBIT 30m"; do
  run_slice $s
done
log "=== T2 COMPLETE ==="
# T3 — full-venue sweeps (done slices no-op via DB-state resume)
for v in WEEX XT HTX PHEMEX MEXC WHITEBIT HL KUCOIN OKX; do
  run_slice "$v"
done
log "=== TRIAGE BACKFILL DONE ==="
