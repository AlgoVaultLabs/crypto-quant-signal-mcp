#!/usr/bin/env bash
# hold-decision-labeler.sh — OPS-HOLD-DECISION-CAPTURE-W1 R2.
#
# Labels captured HOLD decisions against the published triple-barrier rule, using the side the
# engine WOULD have taken. Writes ONLY to `hold_decision_labels`; the published corpus
# (`directional_labels`) is a different table with a different id space and is never touched.
#
# ── SCHEDULE: 41 3 * * * ──
#
# Off-`:00` by ≥3min per the snapshot-sampler rule, and clear of every occupied slot in the 00:00–
# 03:59 band as measured on 2026-08-26: 00:00, 00:04, 00:05, 00:39, 00:57, 01:43, 02:23, 03:00 and
# 03:47. `03:41` is free.
#
# Chosen against the two jobs whose work this one resembles:
#   * nightly-carry-labeler (02:23, worst case +210min → ~05:53). This job deliberately runs INSIDE
#     that window rather than after it: the contended resource is the shared venue weight budget,
#     not wall-clock, and `WeightBudgetSkipError` already defers a group cleanly when the budget is
#     exhausted. Waiting for 06:00 would push the run into the operator digest hour for no gain.
#   * dwr-baseline-snapshot (09:29, 1st of month). Well clear, and it reads only the acted corpus.
#
# ── SILENT ON SUCCESS ──
#
# Data pipeline, not a guard. The verdict token HOLD_LABEL_VERDICT=PASS|FAIL|INDETERMINATE lands in
# the log; nothing pages. Exit 3 is INDETERMINATE — the run was bounded by a budget or lost every
# fetch, which is NOT the same as "there was nothing to label" and must not read as success.
set -euo pipefail

REPO=/opt/crypto-quant-signal-mcp
CTR=crypto-quant-signal-mcp-mcp-server-1
LOG_TAG="[hold-decision-labeler]"

# Bounded so one bad venue cannot consume the whole night. Both knobs are deliberately modest:
# the analysis is powered by distinct (venue, coin) CLUSTERS, so budget spent going deep on one
# coin buys strictly less than the same budget spread wide.
PER_CELL="${HOLD_LABEL_PER_CELL:-3}"
MAX_DECISIONS="${HOLD_LABEL_MAX_DECISIONS:-4000}"
TIME_BUDGET_MIN="${HOLD_LABEL_TIME_BUDGET_MIN:-90}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CTR"; then
  echo "$LOG_TAG $(date -u +%FT%TZ) HOLD_LABEL_VERDICT=INDETERMINATE container $CTR not running"
  exit 3
fi

# `--check` first: reports what WOULD be written and touches nothing. Its output is the record of
# how much backlog existed at the start of the run, which is the number that tells you whether the
# budget above is keeping up — a real run alone cannot distinguish "labeled everything" from
# "labeled its cap and left a growing queue".
docker exec "$CTR" node dist/scripts/backfill-hold-decision-labels.js --check \
  --per-cell "$PER_CELL" --max-decisions "$MAX_DECISIONS" || true

set +e
docker exec "$CTR" node dist/scripts/backfill-hold-decision-labels.js \
  --per-cell "$PER_CELL" \
  --max-decisions "$MAX_DECISIONS" \
  --time-budget-min "$TIME_BUDGET_MIN"
rc=$?
set -e

# Pass the child's exit code through UNCHANGED. Collapsing 3 to 0 here would make INDETERMINATE
# indistinguishable from success at the only place a reader looks, which is the whole failure the
# verdict-token contract exists to prevent.
echo "$LOG_TAG $(date -u +%FT%TZ) exit=$rc"
exit "$rc"
