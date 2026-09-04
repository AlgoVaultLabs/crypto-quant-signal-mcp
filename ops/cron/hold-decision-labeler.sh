#!/usr/bin/env bash
# hold-decision-labeler.sh — OPS-HOLD-DECISION-CAPTURE-W1 R2.
#                            TWO LEGS since EDGE-ATTRIBUTION-CORPUS-DRAIN-W1 R2 (2026-09-04).
#
# Labels captured HOLD decisions against the published triple-barrier rule, using the side the
# engine WOULD have taken. Writes ONLY to `hold_decision_labels`; the published corpus
# (`directional_labels`) is a different table with a different id space and is never touched.
#
# Runs TWO bounded invocations per night — a post-capture DRAIN and a pre-capture RESERVE — for
# reasons and arithmetic given at the split below. Total decisions per night is unchanged.
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
#
# With two legs there are TWO tokens in the log and ONE exit code, combined WORST-WINS (3 > 1 > 0)
# so a green exit still means both legs did their work. The per-leg codes are printed beside it —
# a single collapsed number that hid which leg was cut short would be the same defect the token
# contract exists to prevent, one level up.
#
# EXIT 137 IS EXPECTED AND IS NOT A FAILURE — BUT IT IS NOT FREE EITHER, AND THE REGISTRY'S
# `safe-to-kill` LABEL IS ABOUT INTEGRITY, NOT COST. This job is classified `safe-to-kill` in
# ops/scripts/cron-interlock-registry.json: a deploy recreates the container mid-run and SIGKILLs
# the `docker exec`, which by definition cannot print a token, and the `NOT EXISTS` work-list makes
# the next run relabel whatever was missed. Nothing is CORRUPTED and nothing is permanently lost.
#
# What IS lost is the whole run. Every INSERT happens AFTER the group loop, so a SIGKILL discards
# the entire in-memory batch along with the upstream venue weight already spent on it. MEASURED
# 2026-09-04: killed at 03:57:22Z after ~16 minutes of fetching, `hold_decision_labels` rows
# written that day = ZERO. (A SIGTERM is different — `installGracefulStop` breaks the loop and the
# INSERTs still run. `safe-to-kill` means the deploy sends nothing at all, so this path gets the
# SIGKILL.) Do not read 137 as an error, do not reclassify without re-deriving the interlock row,
# and do not describe the cost as nil — it is one full run per preempting deploy.
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

# ── THE SPLIT — EDGE-ATTRIBUTION-CORPUS-DRAIN-W1 R2 ─────────────────────────────────────────
#
# The work-list is `ORDER BY h.decided_at ASC` with `rn <= PER_CELL`, so it takes the OLDEST row
# in every cell. Since migration 036 the oldest rows carry NO scorer parts, and measured
# 2026-09-04 only 17.4% of this job's output reached a captured parent: it was spending 83% of a
# budget on rows feature attribution cannot use.
#
# Changing the INVOCATION is not changing the DEFAULT. Both flags stay default-off in the script
# and the byte-identical default path is preserved (pinned by
# tests/unit/hold-decision-label-filters.test.ts); the caller opts in, here.
#
# BUDGET IS SPLIT, NOT REDIRECTED, and the reason is a different pre-registration:
# `audits/hold-decision-preregistration-2026-08-26.md` is powered by the pre-capture corpus too,
# and starving one pre-registration to serve another is not a trade this job gets to make.
# Measured 2026-09-04 in its headline stratum (confidence 50–62, tau1.0): the pre-capture corpus
# already carries 3,352 (venue,coin) clusters against a floor of 50 — 67x — so the reserve is not
# what keeps that test alive; what it buys is more rows per already-covered cluster, which
# tightens a cluster-bootstrapped interval. Sized accordingly, and the 2026-09-09 readiness check
# rules on whether to keep it. Totals are unchanged: the drain gets MAX_DECISIONS - RESERVE_MAX.
#
# The RESERVE is the knob; the drain gets what is left. Derived rather than declared twice, so
# `HOLD_LABEL_MAX_DECISIONS` and `HOLD_LABEL_TIME_BUDGET_MIN` keep governing this job's TOTAL
# footprint exactly as they always did — an operator who turns the old knob must not find it
# quietly attached to nothing.
RESERVE_MAX="${HOLD_LABEL_RESERVE_MAX:-600}"
RESERVE_TIME_MIN="${HOLD_LABEL_RESERVE_TIME_MIN:-25}"
DRAIN_MAX=$(( MAX_DECISIONS - RESERVE_MAX ))
DRAIN_TIME_MIN=$(( TIME_BUDGET_MIN - RESERVE_TIME_MIN ))

# Default-deny an incoherent split rather than silently running one empty leg: a zero-row drain
# would look exactly like a drain that found nothing left to label, which is the opposite verdict.
if [ "$DRAIN_MAX" -lt 1 ] || [ "$DRAIN_TIME_MIN" -lt 1 ]; then
  echo "$LOG_TAG $(date -u +%FT%TZ) HOLD_LABEL_VERDICT=INDETERMINATE reserve exceeds the total" \
       "(max=$MAX_DECISIONS reserve=$RESERVE_MAX time=$TIME_BUDGET_MIN reserve_time=$RESERVE_TIME_MIN)"
  exit 3
fi

# Epoch of the OLDEST row carrying scorer parts (2026-08-31T10:34:35Z), measured 2026-09-04.
#
# A STALE VALUE HERE CANNOT PRODUCE A WRONG RESULT — only a slower query. `--require-parts` is the
# authoritative predicate and `--since` is an index bound (`idx_hold_decisions_scan` is
# `(exchange, coin, timeframe, decided_at)`, so the bound is usable inside each partition the
# ROW_NUMBER walks). That asymmetry is why a literal is acceptable here where it would not be for
# a correctness-bearing constant.
SINCE_EPOCH="${HOLD_LABEL_SINCE_EPOCH:-1788172475}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CTR"; then
  echo "$LOG_TAG $(date -u +%FT%TZ) HOLD_LABEL_VERDICT=INDETERMINATE container $CTR not running"
  exit 3
fi

# `--check` first: reports what WOULD be written and touches nothing. Its output is the record of
# how much backlog existed at the start of the run, which is the number that tells you whether the
# budget above is keeping up — a real run alone cannot distinguish "labeled everything" from
# "labeled its cap and left a growing queue". Run on the DRAIN leg's work-list, because that is
# the queue the gate is waiting on; it also prints `since_admitted_without_parts`.
docker exec "$CTR" node dist/scripts/backfill-hold-decision-labels.js --check \
  --since "$SINCE_EPOCH" --require-parts \
  --per-cell "$PER_CELL" --max-decisions "$DRAIN_MAX" || true

set +e
# LEG 1 — the drain: post-capture rows, the ones that carry parts and can feed attribution.
docker exec "$CTR" node dist/scripts/backfill-hold-decision-labels.js \
  --since "$SINCE_EPOCH" --require-parts \
  --per-cell "$PER_CELL" \
  --max-decisions "$DRAIN_MAX" \
  --time-budget-min "$DRAIN_TIME_MIN"
rc_drain=$?

# LEG 2 — the reserve: the UNCHANGED default path, just bounded. It needs no inverse flag; with
# no filters the ASC ordering already lands the great majority of its output on pre-capture rows
# (measured 82.6%), and running the untouched invocation is itself a live exercise of the
# byte-identity claim the unit test makes hermetically.
docker exec "$CTR" node dist/scripts/backfill-hold-decision-labels.js \
  --per-cell "$PER_CELL" \
  --max-decisions "$RESERVE_MAX" \
  --time-budget-min "$RESERVE_TIME_MIN"
rc_reserve=$?
set -e

# WORST WINS. Two legs, two tokens, one exit code — and it may never launder an INDETERMINATE.
# 3 (could not observe) dominates 1 (observed a failure) dominates 0, so a green exit continues to
# mean "both legs did their work", never "one of them was cut short by a budget".
if [ "$rc_drain" -eq 3 ] || [ "$rc_reserve" -eq 3 ]; then rc=3
elif [ "$rc_drain" -ne 0 ] || [ "$rc_reserve" -ne 0 ]; then rc=1
else rc=0
fi

echo "$LOG_TAG $(date -u +%FT%TZ) drain_exit=$rc_drain reserve_exit=$rc_reserve exit=$rc"
exit "$rc"
