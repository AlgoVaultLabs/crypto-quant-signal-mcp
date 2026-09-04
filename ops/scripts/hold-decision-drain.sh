#!/usr/bin/env bash
# hold-decision-drain.sh — EDGE-ATTRIBUTION-CORPUS-DRAIN-W1 R2.
#
# A BOUNDED, ONE-OFF, PER-VENUE drain of the post-capture HOLD backlog, SELL side first.
#
# The nightly labeler (ops/cron/hold-decision-labeler.sh) now splits its budget and keeps the
# corpus growing on its own. This is the accelerant: it exists to close the distance to the
# pre-registered gate in `audits/attribution-gate-preregistration-2026-09-04.md` once, and then to
# stop. It is NOT scheduled and must never be added to a crontab — a second recurring consumer of
# the same venue budgets is exactly the "two individually compliant jobs jointly breach one shared
# budget" defect this estate has already paid for.
#
# ── ONE `docker exec` PER VENUE, ON PURPOSE ──────────────────────────────────────────────────
#
# The AC requires per-venue request counts. Deriving them afterwards from a single mixed run would
# mean reconstructing what was spent where; running one invocation per venue makes the count fall
# out of the loop, and it also bounds the blast radius — a venue that misbehaves ends its own leg
# and nothing else's.
#
# ── EXCLUSIONS ARE DECLARED AND REASONED, NEVER INFERRED ─────────────────────────────────────
#
# Measured 2026-09-04T06:09Z from each venue's own cross-process ledger, batch cap = ceiling -
# interactiveReserve (src/lib/venue-budget-registry.ts):
#
#   HL     682/700 batch, 10 waits  — and OPS-HL-INTERACTIVE-STARVATION-W1 CH3's observation
#                                     window is OPEN. HL is also the SMALLEST pool in the
#                                     work-list (10,924 rows, 2.4%), so excluding it costs
#                                     almost nothing and protects a live measurement.
#   OKX    350/350 batch, 2 waits   — saturated.
#   WEEX    20/20  batch, 7 waits   — saturated; ceiling is 25/min total.
#
# Everything else has real headroom. The order below is BY MEASURED HEADROOM, widest first, so
# that if the drain is interrupted it has already spent its time where contention was lowest.
#
# ── PRIORITY IS ONE-WAY, AND IT IS INHERITED, NOT RE-IMPLEMENTED ─────────────────────────────
#
# `backfill-hold-decision-labels.ts` runs its whole body inside `runAsBatch`, and
# `WeightBudget.acquire` caps a batch caller at `ceiling - interactiveReserve` while an
# interactive one may use the entire ceiling. This script adds NO pacing of its own: a second
# throttle beside the real one is a second thing to drift. It reads the ledgers to REPORT, never
# to decide, and it never mutates a budget.
#
# ── VERDICT ─────────────────────────────────────────────────────────────────────────────────
#
# One terminal `HOLD_DRAIN_VERDICT=PASS|FAIL|INDETERMINATE`. Exit 0 / 1 / 3 — 3 is the token-law
# default for a NEW gate, deliberately NOT check_test_baseline.sh's 2, which is 2 only because it
# already deployed 2. A leg cut short by a venue budget or by a deploy is INDETERMINATE, never a
# pass: "labeled nothing" and "could not observe enough to say" are different facts.
#
#   hold-decision-drain.sh                 # drain, default venue set
#   hold-decision-drain.sh --dry-run       # print the plan and the per-venue backlog; write nothing
#   hold-decision-drain.sh --self-test     # hermetic; no docker, no DB, no network
#   hold-decision-drain.sh --venues GATE,HTX
set -uo pipefail

CTR="${HOLD_DRAIN_CTR:-crypto-quant-signal-mcp-mcp-server-1}"
LOG_TAG="[hold-decision-drain]"

# Same epoch and same asymmetry as the nightly: `--require-parts` is authoritative, so a stale
# value here costs query time and never correctness.
SINCE_EPOCH="${HOLD_DRAIN_SINCE_EPOCH:-1788172475}"
PER_CELL="${HOLD_DRAIN_PER_CELL:-3}"
MAX_PER_VENUE="${HOLD_DRAIN_MAX_PER_VENUE:-1500}"
TIME_PER_VENUE_MIN="${HOLD_DRAIN_TIME_PER_VENUE_MIN:-12}"

# Widest measured batch headroom first. See the exclusions block above for HL / OKX / WEEX.
DEFAULT_VENUES="HTX,GATE,WHITEBIT,BYBIT,BITGET,BINANCE,BINGX,ASTER,KUCOIN,PHEMEX,XT,MEXC"
EXCLUDED_VENUES="HL,OKX,WEEX"

# ── pure helpers (the artifacts a hermetic self-test would otherwise never execute) ──────────

# Ledger JSON -> "used|batchUsed|interactiveUsed|waits|skips|throws". Kept as a pure function
# BECAUSE a --self-test that stubs the docker call would otherwise never run this parser, and a
# seam's parser is precisely the code no scenario covers. Missing/!readable -> all dashes.
parse_ledger() {
  local json="$1"
  python3 -c '
import json,sys
raw = sys.argv[1]
try:
    d = json.loads(raw)
except Exception:
    print("-|-|-|-|-|-"); sys.exit(0)
if not isinstance(d, dict):
    print("-|-|-|-|-|-"); sys.exit(0)
k = ("used","batchUsed","interactiveUsed","waits","skips","throws")
print("|".join(str(d.get(x, "-")) for x in k))
' "$json"
}

# Worst-wins over per-leg exit codes: 3 (could not observe) > 1 (observed a failure) > 0.
# A drain that ran ten clean legs and one truncated one has NOT fully observed its corpus.
combine_verdict() {
  local worst=0 c
  for c in "$@"; do
    case "$c" in
      3) worst=3 ;;
      0) ;;
      *) [ "$worst" -eq 3 ] || worst=1 ;;
    esac
  done
  printf '%s' "$worst"
}

# The declared venue set minus the declared exclusions. An excluded venue passed explicitly is
# REFUSED, not silently dropped: silently honouring half a request is how an exclusion gets
# believed to be in force when it is not.
resolve_venues() {
  local requested="$1" v out=""
  for v in ${requested//,/ }; do
    case ",$EXCLUDED_VENUES," in
      *",$v,"*) printf 'REFUSED %s\n' "$v" >&2; return 2 ;;
    esac
    out="${out:+$out }$v"
  done
  [ -n "$out" ] || return 2
  printf '%s' "$out"
}

# ── self-test ────────────────────────────────────────────────────────────────────────────────

if [ "${1:-}" = "--self-test" ]; then
  fails=0
  check() { # name, expected, actual
    if [ "$2" = "$3" ]; then printf 'SELF-TEST: ok   %s\n' "$1"
    else printf 'SELF-TEST: FAIL %s (expected %s, got %s)\n' "$1" "$2" "$3"; fails=$((fails+1)); fi
  }
  # combine_verdict — every ordering, because "worst wins" is the whole contract
  check "all clean => 0"                 0 "$(combine_verdict 0 0 0)"
  check "one failure => 1"               1 "$(combine_verdict 0 1 0)"
  check "one indeterminate => 3"         3 "$(combine_verdict 0 0 3)"
  check "indeterminate beats failure"    3 "$(combine_verdict 1 3 1)"
  check "indeterminate first still wins" 3 "$(combine_verdict 3 1 0)"
  check "empty => 0"                     0 "$(combine_verdict)"
  # parse_ledger — the seam parser, asserted directly
  check "ledger parsed positionally" "702|682|20|10|0|0" \
    "$(parse_ledger '{"windowStartMs":1,"used":702,"batchUsed":682,"interactiveUsed":20,"waits":10,"skips":0,"throws":0}')"
  check "absent keys read as dashes, never 0" "-|-|-|-|-|-" "$(parse_ledger '{}')"
  check "unreadable ledger is dashes, never 0" "-|-|-|-|-|-" "$(parse_ledger 'not json')"
  check "a JSON scalar is not a ledger"        "-|-|-|-|-|-" "$(parse_ledger '7')"
  # resolve_venues — the exclusions must be REFUSALS
  check "healthy venues resolve" "GATE HTX" "$(resolve_venues 'GATE,HTX')"
  resolve_venues 'GATE,HL' >/dev/null 2>&1; check "an excluded venue is refused" 2 "$?"
  resolve_venues 'OKX'     >/dev/null 2>&1; check "OKX is refused"               2 "$?"
  resolve_venues 'WEEX'    >/dev/null 2>&1; check "WEEX is refused"              2 "$?"
  resolve_venues ''        >/dev/null 2>&1; check "an empty set is refused"      2 "$?"
  # the default set must not contain an excluded venue — a list and a rule that disagree is worse
  # than either alone, and nothing else would catch it
  for v in ${EXCLUDED_VENUES//,/ }; do
    case ",$DEFAULT_VENUES," in
      *",$v,"*) printf 'SELF-TEST: FAIL default set contains excluded venue %s\n' "$v"; fails=$((fails+1)) ;;
      *) printf 'SELF-TEST: ok   default set excludes %s\n' "$v" ;;
    esac
  done
  # vacuity: this corpus is one WE construct, so an empty one means the test built nothing
  if [ -z "$DEFAULT_VENUES" ]; then
    printf 'SELF-TEST: FAIL default venue set is empty\n'; fails=$((fails+1))
  fi
  printf 'HOLD_DRAIN_SELFTEST=%s failures=%s\n' "$([ "$fails" -eq 0 ] && echo PASS || echo FAIL)" "$fails"
  [ "$fails" -eq 0 ] && exit 0 || exit 1
fi

# ── live ─────────────────────────────────────────────────────────────────────────────────────

DRY_RUN=0
VENUES_REQ="$DEFAULT_VENUES"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --venues)  VENUES_REQ="${2:-}"; shift 2 ;;
    *) echo "$LOG_TAG unknown argument '$1'" >&2
       echo "HOLD_DRAIN_VERDICT=INDETERMINATE"; exit 3 ;;
  esac
done

if ! VENUES=$(resolve_venues "$VENUES_REQ"); then
  echo "$LOG_TAG refusing: the venue set is empty or names an excluded venue ($EXCLUDED_VENUES)" >&2
  echo "HOLD_DRAIN_VERDICT=INDETERMINATE"; exit 3
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$CTR"; then
  echo "$LOG_TAG $(date -u +%FT%TZ) container $CTR not running"
  echo "HOLD_DRAIN_VERDICT=INDETERMINATE"; exit 3
fi

ledger_of() { # venue -> raw JSON (or '' when the ledger does not exist yet)
  local slug
  slug=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  docker exec "$CTR" cat "/tmp/algovault-${slug}-weight.json" 2>/dev/null || printf ''
}

echo "$LOG_TAG $(date -u +%FT%TZ) start since=$SINCE_EPOCH per_cell=$PER_CELL" \
     "max_per_venue=$MAX_PER_VENUE time_per_venue_min=$TIME_PER_VENUE_MIN dry_run=$DRY_RUN"
echo "$LOG_TAG venues=$VENUES"
echo "$LOG_TAG excluded=$EXCLUDED_VENUES (measured batch saturation / open HL observation window)"

codes=()
for v in $VENUES; do
  before=$(parse_ledger "$(ledger_of "$v")")
  # --check first: the per-venue backlog, and the --require-parts vs --since disagreement count.
  docker exec "$CTR" node dist/scripts/backfill-hold-decision-labels.js --check \
    --venue "$v" --since "$SINCE_EPOCH" --require-parts --side sell \
    --per-cell "$PER_CELL" --max-decisions "$MAX_PER_VENUE" 2>&1 | sed "s/^/$LOG_TAG [$v] /" || true

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "$LOG_TAG [$v] dry-run — nothing written; ledger_before=$before"
    continue
  fi

  docker exec "$CTR" node dist/scripts/backfill-hold-decision-labels.js \
    --venue "$v" --since "$SINCE_EPOCH" --require-parts --side sell \
    --per-cell "$PER_CELL" --max-decisions "$MAX_PER_VENUE" \
    --time-budget-min "$TIME_PER_VENUE_MIN" 2>&1 | sed "s/^/$LOG_TAG [$v] /"
  rc=${PIPESTATUS[0]}
  codes+=("$rc")

  after=$(parse_ledger "$(ledger_of "$v")")
  # Both samples printed, never a delta: the ledger is a per-MINUTE window that rolls underneath
  # us, so before/after can straddle a roll and their difference is not a quantity. Report the
  # observations; let a reader who knows the window decide what they mean.
  echo "$LOG_TAG [$v] exit=$rc ledger_before=$before ledger_after=$after" \
       "(used|batchUsed|interactiveUsed|waits|skips|throws)"
done

if [ "$DRY_RUN" -eq 1 ]; then
  echo "$LOG_TAG $(date -u +%FT%TZ) dry-run complete; nothing written"
  echo "HOLD_DRAIN_VERDICT=PASS"; exit 0
fi

worst=$(combine_verdict "${codes[@]:-0}")
case "$worst" in
  0) verdict=PASS ;;
  1) verdict=FAIL ;;
  *) verdict=INDETERMINATE ;;
esac
echo "$LOG_TAG $(date -u +%FT%TZ) legs=${#codes[@]} codes=${codes[*]:-none}"
echo "HOLD_DRAIN_VERDICT=$verdict"
exit "$worst"
