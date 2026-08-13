#!/usr/bin/env bash
# carry-tracker-publish.sh — EDGE-CARRY-SCOREBOARD-W1
#
# Daily host wrapper for the public carry-tracker aggregate publisher. Recomputes
# carry_tracker_weekly / carry_tracker_pooled from paper_carry_track using the CANONICAL
# readiness derivation (src.research.carry.readiness: dedupe_paired + assess +
# stats.block_bootstrap_ci), so /api/carry-tracker-public can be a pure SELECT and the
# TypeScript side performs no statistics at all.
#
# ── Why this wrapper lives in the repo and its three siblings do not ─────────
# /opt/algovault-carry/{carry-scorer,paper-carry-tracker,carry-retrain}.sh are host-authored
# with no repo ancestor — measured 2026-08-13, /opt/algovault-carry is not a git checkout at
# all. Rather than add a fourth unprovenanced script, this one is invoked straight from the
# deploy checkout (`ops/cron/**` is NOT in deploy.yml's paths-ignore precisely because these
# wrappers are read from the host checkout). Retro-fitting the other three is
# OPS-CARRY-CRON-WRAPPER-PROVENANCE-W{NEXT}.
#
# ── Not a monitoring artifact, deliberately ─────────────────────────────────
# No ops/monitoring/monitoring-inventory.json row: this is a DATA-PIPELINE job of the same
# class as its three siblings, none of which is inventoried. The reconciler's ORPHAN scan is
# scoped to /opt/algovault-monitoring/ and DARK runs inventory -> crontab, so a row here would
# be the only one of the four and would misclassify the job rather than cover it.
#
# ── Cadence ─────────────────────────────────────────────────────────────────
# Daily 01:43 UTC. The MONDAY fire is the post-ISO-week-close run that finalises the week that
# just closed (a week is only marked complete once data reaches INTO the following week, which
# on hourly HL intervals is long before 01:43). The other six keep `updated_at` honest and the
# in-progress week visible, flagged `partial`. Off-`:00` and clear of every neighbour:
# scorer :07 hourly, merkle 00:05, snapshot-landing 00:39, labeler 02:23, paper tracker 03:47,
# retrain Sun 04:37.
#
# Failure contract: fail-soft. A failed publish leaves the previous rows in place and the
# endpoint serves them behind a labelled stale banner. Forensic log only, NO Telegram — this
# is a public-surface freshness concern, not an operator-actionable serving fault.
set -uo pipefail

CARRY_ROOT=/opt/algovault-carry
PY="$CARRY_ROOT/.venv/bin/python"

[ -x "$PY" ] || { echo "[carry-tracker-publish] interpreter $PY missing — aborting"; exit 1; }

cd "$CARRY_ROOT" || exit 1
PYTHONUNBUFFERED=1 PYTHONPATH="$CARRY_ROOT/pkg" exec "$PY" -m src.research.carry.tracker_publish "$@"
