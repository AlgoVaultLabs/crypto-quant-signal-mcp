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
# convergence = remaining STOPS MATERIALLY DECREASING across attempts.
# EPSILON, not equality (observed 2026-07-23): a live venue keeps EMITTING —
# signals whose eval windows close DURING a long attempt shave remaining by
# ~tens, so exact remaining==prev never fires and a dead slice grinds 2h
# attempts forever. Fresh-arrival drift is tens/attempt; real backfill progress
# is hundreds+. CONVERGE_EPS=50 separates the two regimes cleanly.
#
# Pacing: every kline fetch goes through the container's shared weight-budget
# batch lane (418/429 typed, never blind-retried) — the riders are inherited.
set -u
CTR=crypto-quant-signal-mcp-mcp-server-1
LOG=/var/log/label-backfill-triage.log
LOCK=/var/lock/algovault-label-backfill.lock
MAX_ATTEMPTS=6
CONVERGE_EPS=50   # |prev−remaining| ≤ EPS ⇒ converged (fresh-arrival drift, not progress)

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
  local prev=-1 rem attempt=1 err_waits=0
  while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    log "slice $venue ${tf:-ALL} attempt=$attempt START"
    docker exec "$CTR" node dist/scripts/backfill-directional-labels.js "${flags[@]}" >> "$LOG" 2>&1
    rem=$(check_remaining "$venue" "$tf"); rem=${rem:-ERR}
    log "slice $venue ${tf:-ALL} attempt=$attempt end remaining=$rem (prev=$prev)"
    if [ "$rem" = "ERR" ]; then
      # deploy-flap guard: an instant docker-exec failure must not BURN attempts
      # (observed 2026-07-21: 6 ERR-attempts in <1s abandoned whole venues while
      # the container was mid-recreate). Wait for the stack; bounded separately.
      err_waits=$((err_waits + 1))
      if [ "$err_waits" -gt 20 ]; then
        log "slice $venue ${tf:-ALL} 20 ERR-waits (~30min) — container not coming back; moving on (resumable)"
        return 1
      fi
      log "slice $venue ${tf:-ALL} ERR — waiting 90s for a healthy container (attempt NOT burned; err_wait=$err_waits/20)"
      sleep 90
      continue
    fi
    if [ "$rem" -eq 0 ] || { [ "$prev" -ge 0 ] && [ $((prev - rem)) -le "$CONVERGE_EPS" ] && [ $((prev - rem)) -ge $((0 - CONVERGE_EPS)) ]; }; then
      log "slice $venue ${tf:-ALL} CONVERGED remaining=$rem (delta=$((prev - rem)) ≤ eps=$CONVERGE_EPS)"
      return 0
    fi
    prev=$rem
    attempt=$((attempt + 1))
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
