#!/usr/bin/env bash
# dwr-baseline-snapshot.sh — EDGE-DWR-REFRESH-W1 R4
#
# Monthly host wrapper for the DWR / Directional-Edge scoreboard writer. Recomputes the baseline
# from directional_labels + signals through the CANONICAL report (`buildReport()` in
# src/scripts/dwr-baseline-report.ts -> dwr-baseline.ts -> edge-stats.ts) and upserts one row per
# (calendar month x barrier spec) into `dwr_baseline_runs`, so the operator digest and any later
# consumer READ the baseline instead of re-deriving it by hand.
#
# ── Why this exists at all ───────────────────────────────────────────────────
# The previous baseline was computed by hand twice, seven weeks apart, and by the second time its
# numbers were already being cited under the FIRST run's filename date
# (audits/dwr-baseline-2026-07-03.json is content from 2026-07-05, commit 020d5f4). A metric that
# is only ever "discovered" gets mis-dated; a metric with a monthly row and a run_ts does not.
#
# ── Invoked from the deploy checkout, like its siblings ──────────────────────
# `ops/cron/**` is NOT in deploy.yml's paths-ignore precisely so these wrappers ship into the host
# checkout and need no separate SSH install. Shape copied from ops/cron/carry-tracker-publish.sh.
#
# ── Cadence ─────────────────────────────────────────────────────────────────
# Monthly, 1st at 09:29 UTC. Off-`:00` per CLAUDE.md. Clear of every neighbour that touches the
# same corpus or the same box: the DIRECTIONAL LABELER is step 3 of nightly-carry-labeler at 02:23
# with a <=210-min budget (worst case 05:53), paper tracker 03:47, carry retrain Sun 04:37, the
# operator digest 08:00, xrepo-ci 09:41, and the other monthly jobs at 00:00 / 04:00 / 08:07 /
# 08:19. 09:29 therefore reads a corpus the labeler has finished extending, and collides with
# nothing.
#
# ── Idempotency ─────────────────────────────────────────────────────────────
# The (run_month, spec) primary key means a re-run inside the same month REFRESHES that month's
# row rather than appending. So a forced verification run cannot inflate the series — which is
# what makes it safe to run this by hand at any time.
#
# ── Failure contract: fail-soft, no Telegram ────────────────────────────────
# The script prints exactly one `DWR_SNAPSHOT_VERDICT=PASS|FAIL|INDETERMINATE` line; a
# non-zero exit lands in this log and pages nobody. A missed month leaves the previous months
# intact and mis-states nothing — this is an internal measurement series, not an operator-
# actionable serving fault. Consumers gate on the TOKEN, never on the exit code.
# NOT shipped deliberately: a staleness alarm on the series. R4 specified "silent on success",
# and an alarm here would be the wave's own unrequested alert contract. If paging is wanted,
# that is OPS-DWR-SERIES-FRESHNESS-W{NEXT}, and it must measure the PRODUCER (this job's
# attempt recency), never the rendered row.
set -uo pipefail

CTR=crypto-quant-signal-mcp-mcp-server-1

docker inspect -f '{{.State.Running}}' "$CTR" 2>/dev/null | grep -qx true || {
  echo "[dwr-baseline-snapshot] $(date -u +%FT%TZ) container $CTR not running — skipping"
  echo "DWR_SNAPSHOT_VERDICT=INDETERMINATE"
  exit 3
}

echo "[dwr-baseline-snapshot] $(date -u +%FT%TZ) start"
exec docker exec "$CTR" node dist/scripts/dwr-baseline-snapshot.js "$@"
