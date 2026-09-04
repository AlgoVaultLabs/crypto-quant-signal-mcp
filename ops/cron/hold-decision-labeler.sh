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
# psql, never `docker exec <app> node -e`: nested ssh+docker+node quoting mangles SQL string
# literals, and the app image resolves modules from /app, not from a script path.
PG_CTR="${HOLD_LABEL_PG_CTR:-crypto-quant-signal-mcp-postgres-1}"
PG_USER="${HOLD_LABEL_PG_USER:-algovault}"
PG_DB="${HOLD_LABEL_PG_DB:-signal_performance}"
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

# ── THE DRAIN LEG IS PER-VENUE — EDGE-ATTRIBUTION-CORPUS-DRAIN-W1, architect ruling (c) ─────
#
# MEASURED 2026-09-04, and it is worse than the parts problem this wave was dispatched for: this
# job has labeled ONE VENUE. Six consecutive scheduled nights — 08-27, 08-28, 08-31, 09-01, 09-02,
# 09-03 — are 100% ASTER (3,969 / 3,711 / 3,355 / 3,333 parents). Fourteen venues get nothing.
#
# The cause is the work-list's OUTER clause, not its stratification:
#     ORDER BY exchange, coin, timeframe, decided_at  LIMIT $maxRows
# The per-cell ROW_NUMBER caps DEPTH; the outer ORDER BY then hands the whole budget to whichever
# venue sorts FIRST. ASTER has 2,803 eligible cells x 3 per cell = ~8,400 candidates against a
# 4,000 limit, so it fills the budget alone and the scan never reaches BINANCE.
#
# buildWorklistSql's own comment claims the opposite — "what makes this STRATIFIED rather than
# merely LIMITed: a bare ORDER BY decided_at LIMIT n would hand the entire budget to whichever
# venue happens to be oldest". It has exactly that defect, keyed on ALPHABET instead of age.
#
# This matters more here than anywhere else because the pre-registered analyses are powered by
# distinct (venue, coin) CLUSTERS. Pointing a single-venue labeler at post-capture rows would have
# produced a post-capture corpus of one venue — a faster route to a corpus nobody can use.
#
# FIXED AT THE CALL SITE, NOT IN THE QUERY, and that split is deliberate: the generator fix
# (ordering the outer select by `rn` first, so every cell's 1st row is taken before any cell's
# 2nd) changes DEFAULT worklist behaviour and re-baselines the golden that proves this wave's
# flags are additive. That review belongs to its own wave —
# `EDGE-LABELER-BREADTH-ORDERING-W{NEXT}` — and not to the wave that added the flags.
# Architect ruling (c), 2026-09-04.

# The venue set is DERIVED, never listed here. A hardcoded list is a duplicated fact that goes
# stale the day a venue is promoted — this estate has paid for that with EXCHANGE_COUNT already —
# and the set that matters is "venues with capturable rows", which only the data knows.
#
# NOTE THE DELIBERATE DIFFERENCE FROM ops/scripts/hold-decision-drain.sh, which EXCLUDES HL, OKX
# and WEEX. That script is a bulk accelerant run on demand at an arbitrary hour, so it must not
# pile onto a batch lane already at its cap. This job is the steady-state corpus builder, and a
# permanent venue exclusion here would bake exactly the bias this loop exists to remove. The
# contention answer for the nightly is the one this file already relied on to run inside the
# carry-labeler's window: `WeightBudgetSkipError` defers a saturated group cleanly, and a per-venue
# slice of ~226 decisions makes a tight lane cost a deferral rather than a wedge. Interactive
# callers are protected by construction either way (`interactiveReserve` is unreachable from the
# batch class), which is why HL's open CH3 observation window is not a reason to drop HL from a
# batch-class job.
venue_list() {
  docker exec "$PG_CTR" psql -U "$PG_USER" -d "$PG_DB" -tA -c \
    "SELECT DISTINCT exchange FROM hold_decisions
      WHERE captured_at > now() - interval '2 days'
        AND exchange IS NOT NULL AND would_be_side <> 0 AND timeframe <> '1m'
      ORDER BY 1" 2>/dev/null
}

VENUES="$(venue_list | tr -d '\r' | tr '\n' ' ')"
VENUE_N=$(printf '%s' "$VENUES" | wc -w | tr -d ' ')

# VACUITY BELONGS WHERE THE CORPUS IS CONSTRUCTED. We wrote this query, so an empty venue set
# means the QUERY broke, not that the estate has no venues. Refuse; never quietly label nothing.
if [ "$VENUE_N" -lt 1 ]; then
  echo "$LOG_TAG $(date -u +%FT%TZ) HOLD_LABEL_VERDICT=INDETERMINATE venue_list returned no venues"
  exit 3
fi

PER_VENUE_MAX=$(( DRAIN_MAX / VENUE_N ));       [ "$PER_VENUE_MAX" -ge 1 ] || PER_VENUE_MAX=1
PER_VENUE_TIME=$(( DRAIN_TIME_MIN / VENUE_N )); [ "$PER_VENUE_TIME" -ge 1 ] || PER_VENUE_TIME=1

echo "$LOG_TAG $(date -u +%FT%TZ) venues=$VENUE_N [$VENUES] per_venue_max=$PER_VENUE_MAX" \
     "per_venue_time_min=$PER_VENUE_TIME drain_max=$DRAIN_MAX reserve_max=$RESERVE_MAX"

# `--check` first on the whole drain work-list: what WOULD be written, touching nothing. It is the
# record of how much backlog existed at the start — a real run alone cannot distinguish "labeled
# everything" from "labeled its cap and left a growing queue" — and it also prints
# `since_admitted_without_parts`, the --since vs --require-parts disagreement count.
docker exec "$CTR" node dist/scripts/backfill-hold-decision-labels.js --check \
  --since "$SINCE_EPOCH" --require-parts \
  --per-cell "$PER_CELL" --max-decisions "$DRAIN_MAX" || true

set +e
# LEG 1..N — the drain, one invocation per venue so no venue can consume another's budget.
rc_drain=0
for v in $VENUES; do
  # Re-checked per leg. A deploy recreates the container mid-run, and `docker exec` into a stopped
  # container exits 1 — the SAME code the labeler uses for its own FAIL. Measured on the drain
  # script's first live run: ten legs reported exit=1 having executed nothing. "Could not run" is
  # INDETERMINATE, never FAIL. (Second consumer of this discriminator after
  # ops/scripts/hold-decision-drain.sh; a shared helper is DEFERRED to the 3rd per the
  # 3-example-threshold rule, and both copies name each other so neither drifts unnoticed.)
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CTR"; then
    echo "$LOG_TAG [$v] SKIPPED — container $CTR not running. INDETERMINATE, not a failure."
    rc_drain=3; continue
  fi
  docker exec "$CTR" node dist/scripts/backfill-hold-decision-labels.js \
    --venue "$v" --since "$SINCE_EPOCH" --require-parts \
    --per-cell "$PER_CELL" \
    --max-decisions "$PER_VENUE_MAX" \
    --time-budget-min "$PER_VENUE_TIME"
  rc_v=$?
  [ "$rc_v" -eq 137 ] && rc_v=3   # SIGKILLed by a deploy: did not observe, so never a FAIL
  echo "$LOG_TAG [$v] exit=$rc_v"
  if [ "$rc_v" -eq 3 ]; then rc_drain=3
  elif [ "$rc_v" -ne 0 ] && [ "$rc_drain" -ne 3 ]; then rc_drain=1
  fi
done

# LEG N+1 — the reserve: the UNCHANGED default invocation, just bounded. No inverse flag needed;
# with no filters the ASC ordering already lands the great majority of its output on pre-capture
# rows, and running the untouched form is itself a live exercise of the byte-identity claim the
# unit test makes hermetically. Left UNLOOPED on purpose: it feeds the HOLD-discipline corpus,
# whose (venue,coin) cluster floor is already met 67x, so its concentration is not load-bearing —
# and looping it would change the one invocation this wave promised to leave alone.
docker exec "$CTR" node dist/scripts/backfill-hold-decision-labels.js \
  --per-cell "$PER_CELL" \
  --max-decisions "$RESERVE_MAX" \
  --time-budget-min "$RESERVE_TIME_MIN"
rc_reserve=$?
set -e

# WORST WINS. Many legs, many tokens, one exit code — and it may never launder an INDETERMINATE.
# 3 (could not observe) dominates 1 (observed a failure) dominates 0, so a green exit continues to
# mean every leg did its work, never that one was cut short by a budget or a deploy.
if [ "$rc_drain" -eq 3 ] || [ "$rc_reserve" -eq 3 ]; then rc=3
elif [ "$rc_drain" -ne 0 ] || [ "$rc_reserve" -ne 0 ]; then rc=1
else rc=0
fi

echo "$LOG_TAG $(date -u +%FT%TZ) drain_exit=$rc_drain reserve_exit=$rc_reserve exit=$rc"
exit "$rc"
