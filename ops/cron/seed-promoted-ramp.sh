#!/usr/bin/env bash
# ops/cron/seed-promoted-ramp.sh — OPS-SEED-PROMOTED-RAMP-W1 (2026-07-07)
#
# WHY. The 7 promoted venues that are neither the fast-4 (BINANCE/BYBIT/OKX/BITGET)
# nor HL — ASTER,BINGX,GATE,HTX,KUCOIN,MEXC,PHEMEX — were seeded ONLY by the
# oversubscribed all-17 3m catch-all line, so they lapsed past the monitor's 45-min
# freshness SLA (the daily "Seed OUTAGE" TG alert). Root cause: the producer's per-TF
# seed lines hardcoded `--exchange-list BINANCE,BYBIT,OKX,BITGET`, decoupled from the
# monitor's dynamic `listVenues('promoted')` SoT. The orchestrator generator's own
# 2026-06-07 comment named this fix: a `--status promoted --exclude HL` line that
# auto-enrolls every promoted venue (incl. future promotions) at RUNTIME — so a venue
# promotion becomes a single `venues.status` flip with no crontab edit, ever.
#
# WHAT. An IDEMPOTENT, backed-up, reviewable SUBSTRING transform of the live crontab
# (NOT a block rebuild — it edits only the intended lines, anchored on their per-TF
# log-file names, so it can never drop/reorder unrelated lines):
#
#   standalone 3m line  (…/seed-3m-standard.log):
#       --timeframe 3m --top 50                              [all 17 venues, ~595s, overruns]
#     → --timeframe 3m --top <TOP_3M> --status promoted --exclude HL
#                                                            [11 venues, ~115s @top-15, fits 180s]
#   orch 5m/15m/30m/1h/2h/4h/8h/12h lines (…/seed-orch-<tf>.log):
#       --exchange-list BINANCE,BYBIT,OKX,BITGET
#     → --status promoted --exclude HL      [+ 5m only: --top 50 → --top <TOP_5M>]
#   orch 1d line (…/seed-orch-1d.log):    LEFT UNCHANGED  (operator: skip 1d for new
#                                         venues; the fast-4 keep their existing 1d)
#   HL legacy lines, --status shadow lines, monitor/equities/canary lines: UNTOUCHED
#
# Concurrency stays 1 (c>=2 overran 13+min historically; architect-pinned to c=1).
# Coin tops on the tight 3m/5m lines were capacity-measured (~35s/venue @ top-50 on the
# CPX42, I/O-bound) to keep 11 venues ≤0.8× cadence at c=1. TOP_3M/TOP_5M are env-tunable.
#
# REQUIRES the deployed seeder to support `--exclude` (OPS-SEED-PROMOTED-RAMP-W1 code —
# deploy that FIRST; the old --exchange-list lines never pass --exclude, so it is safe
# for the code to land before this runs).
#
# Modes:
#   --check              Print a unified diff of the transform. ZERO writes.
#   --apply              Back up the crontab (/opt/crontab.bak-<ts>), transform, validate
#                        (firewall: shadow + HL line counts + total line count unchanged;
#                        1d orch line still --exchange-list), install. Idempotent.
#   --revert <backup>    crontab <backup>.
#   --set-concurrency N  (Re)set --concurrency on the tight 3m + 5m lines (OPS-SEED-
#                        CONCURRENCY-TUNE-W1; validated safe value = 2; env SEED_RAMP_CONCURRENCY).
set -euo pipefail

TOP_3M="${SEED_RAMP_TOP_3M:-15}"
TOP_5M="${SEED_RAMP_TOP_5M:-30}"
# OPS-SEED-CONCURRENCY-TUNE-W1 (2026-07-08): the tight 3m + 5m lines carry --concurrency 2.
# c=2 is the empirically-validated safe value (3m 95.7s / 5m 124.9s, overrun=false, 0 bans);
# the ceiling is the exchanges' per-IP rate-limits (Bybit 10006 at c=3+top-50), NOT box CPU.
CONC="${SEED_RAMP_CONCURRENCY:-2}"
NEW_SEL='--status promoted --exclude HL'
# OPS-VENUE-GO-LIVE-15-W1 (Q2-B): WhiteBIT's public kline supports only {1m,15m,30m,1h,4h,1d}; its
# 3m/5m substitute to 15m (5×/3× coarser) — a sub-15m WR built on 15m candles cannot resolve sub-15m
# PFE (Factuality). So WhiteBIT is excluded from the TIGHT (3m + 5m) lines ONLY; it keeps 15m+ (its
# native cadences). Extendable to any future coarse-substitution venue via SEED_RAMP_TIGHT_EXCLUDE.
TIGHT_EXCLUDE="${SEED_RAMP_TIGHT_EXCLUDE:-HL,WHITEBIT}"
TIGHT_SEL="--status promoted --exclude $TIGHT_EXCLUDE"
BACKUP_DIR="${SEED_RAMP_BACKUP_DIR:-/opt}"

cur() { crontab -l 2>/dev/null || true; }

transform() {
  # OPS-VENUE-GO-LIVE-15-W1: the TIGHT 3m + 5m lines carry TIGHT_SEL (excludes WhiteBIT — Q2-B);
  # 15m+ keep NEW_SEL. 5m is split out of the orch group so it inherits the tight selector.
  awk -v newsel="$NEW_SEL" -v tightsel="$TIGHT_SEL" -v top3m="$TOP_3M" -v top5m="$TOP_5M" -v conc="$CONC" '
  {
    line = $0
    if (line ~ /seed-3m-standard\.log/ && line ~ /--timeframe 3m --top 50/) {
      sub(/--timeframe 3m --top 50/, "--timeframe 3m --top " top3m " " tightsel " --concurrency " conc, line)
    } else if (line ~ /seed-orch-5m\.log/ && line ~ /--exchange-list BINANCE,BYBIT,OKX,BITGET/) {
      sub(/--exchange-list BINANCE,BYBIT,OKX,BITGET/, tightsel, line)
      sub(/--top 50/, "--top " top5m, line); sub(/--concurrency 1/, "--concurrency " conc, line)
    } else if (line ~ /seed-orch-(15m|30m|1h|2h|4h|8h|12h)\.log/ && line ~ /--exchange-list BINANCE,BYBIT,OKX,BITGET/) {
      sub(/--exchange-list BINANCE,BYBIT,OKX,BITGET/, newsel, line)
    }
    print line
  }'
}

validate() {
  local f="$1" sh_b sh_a hl_b hl_a lc_b lc_a
  [ -s "$f" ] || { echo "ERROR: refusing to install an empty crontab" >&2; exit 1; }
  sh_b=$(cur | grep -c -- '--status shadow' || true); sh_a=$(grep -c -- '--status shadow' "$f" || true)
  [ "$sh_b" = "$sh_a" ] || { echo "ERROR: shadow line count changed ($sh_b -> $sh_a) — firewall" >&2; exit 1; }
  hl_b=$(cur | grep -c 'seed-hl\.log' || true); hl_a=$(grep -c 'seed-hl\.log' "$f" || true)
  [ "$hl_b" = "$hl_a" ] || { echo "ERROR: HL legacy line count changed ($hl_b -> $hl_a) — firewall" >&2; exit 1; }
  lc_b=$(cur | grep -c '' || true); lc_a=$(grep -c '' "$f" || true)
  [ "$lc_b" = "$lc_a" ] || { echo "ERROR: total line count changed ($lc_b -> $lc_a) — a substring transform must not add/remove lines" >&2; exit 1; }
  grep -qE 'seed-orch-1d\.log' "$f" && grep -qE 'timeframe 1d --exchange-list' "$f" \
    || { echo "ERROR: 1d orch line not preserved as --exchange-list (skip-1d firewall)" >&2; exit 1; }
}

case "${1:-}" in
  --check)
    echo "=== unified diff (current → transformed), ZERO writes ==="
    diff -u <(cur) <(cur | transform) || true
    echo
    echo "lines that WOULD carry '$NEW_SEL': $(cur | transform | grep -cE -- '--status promoted --exclude HL' || true)"
    ;;
  --apply)
    ts=$(date -u +%Y%m%dT%H%M%SZ); bkp="$BACKUP_DIR/crontab.bak-$ts"
    cur > "$bkp"; echo "backup: $bkp"
    tmp=$(mktemp); cur | transform > "$tmp"
    validate "$tmp"
    crontab "$tmp"; rm -f "$tmp"
    echo "APPLIED — promoted seed lines (3m/5m/15m/30m/1h/2h/4h/8h/12h) now use: $NEW_SEL"
    echo "revert: $0 --revert $bkp"
    ;;
  --revert)
    [ -n "${2:-}" ] && [ -f "${2:-}" ] || { echo "usage: $0 --revert <backup-path>" >&2; exit 1; }
    crontab "$2"; echo "REVERTED crontab from $2"
    ;;
  --set-concurrency)
    # OPS-SEED-CONCURRENCY-TUNE-W1: (re)set --concurrency on the tight 3m + 5m promoted
    # lines of the CURRENT crontab (idempotent — strip existing, add fresh). Default 2.
    n="${2:-$CONC}"
    case "$n" in 1|2|3|4|5|6|7|8) ;; *) echo "usage: $0 --set-concurrency <1-8>" >&2; exit 1 ;; esac
    ts=$(date -u +%Y%m%dT%H%M%SZ); bkp="$BACKUP_DIR/crontab.bak-$ts"
    cur > "$bkp"; echo "backup: $bkp"
    tmp=$(mktemp)
    cur | sed -E "/seed-(3m-standard|orch-5m)\.log/{ s/ --concurrency [0-9]+//; s/ >>/ --concurrency $n >>/ }" > "$tmp"
    validate "$tmp"
    crontab "$tmp"; rm -f "$tmp"
    echo "set --concurrency $n on the 3m + 5m promoted lines"; echo "revert: $0 --revert $bkp"
    ;;
  *) echo "usage: $0 --check | --apply | --revert <backup-path> | --set-concurrency <1-8>" >&2; exit 1 ;;
esac
