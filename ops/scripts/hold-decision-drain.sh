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
#                                     RE-CONFIRMED 2026-09-04T12:04Z mid-drain: still 672/700
#                                     with 10 waits, i.e. persistent, not a sampling accident.
#   WEEX    20/20  batch, 7 waits   — saturated; the ceiling is 25/min TOTAL, so this is
#                                     structural rather than a busy moment. Re-confirmed
#                                     2026-09-04T12:04Z: 20/20 with 16 waits.
#
# ── OKX WAS EXCLUDED ON A SAMPLE TOO THIN TO CARRY IT, AND IS BACK ──────────────────────────
#
# It was dropped on ONE one-minute window (350/350, 2 waits, 2026-09-04T06:09Z). Re-measured
# mid-drain at 12:04Z the same ledger read **161/350** — the 06:09 reading was a busy window, not
# a standing condition, and a permanent exclusion resting on a single sample is the same
# "a measured baseline is meaningless without its instrument" error this estate keeps paying for.
# HL and WEEX survive re-measurement; OKX did not, so it is restored. Its pool is not small
# either: 18,241 eligible post-capture rows, the 6th largest.
#
# The general rule this leaves behind: an exclusion here must rest on a REPEATED reading or on a
# structural fact (WEEX's 25/min ceiling), never on one window.
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

# Widest measured batch headroom first. See the exclusions block above for HL / WEEX.
DEFAULT_VENUES="HTX,GATE,WHITEBIT,BYBIT,BITGET,BINANCE,BINGX,ASTER,KUCOIN,PHEMEX,OKX,XT,MEXC"
EXCLUDED_VENUES="HL,WEEX"

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

# Is the app container up RIGHT NOW? Cheap, and it is the discriminator below.
container_up() { docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CTR"; }

# `docker exec` into a container that is not running exits **1** with
#   Error response from daemon: container <id> is not running
# on stderr — the SAME code the labeler uses for its own HOLD_LABEL_VERDICT=FAIL. So the exit code
# ALONE cannot tell "the labeler ran and failed" from "the labeler never started", and collapsing
# them publishes a confident wrong verdict.
#
# MEASURED 2026-09-04, by this script, on its own first real run: a deploy recreated the container
# mid-drain; GATE died with 137 and the TEN venues after it each reported exit=1 having executed
# nothing at all. HOLD_DRAIN_VERDICT=FAIL over ten legs that never ran. FAIL means "observed a
# failure"; this is "could not observe", which is INDETERMINATE, and the whole point of the token
# contract is that those two must not share a code.
#
# So a non-zero leg is re-classified to 3 when either signal says the container was the cause.
# BOTH are checked because each alone has a hole: the container may have come BACK by the time we
# look (a deploy takes ~1-2 min), and the daemon's wording may change.
leg_was_container_fault() {  # <rc> <captured-output-file>
  [ "$1" -eq 0 ] && return 1
  # 137 = 128+SIGKILL. A killed leg did not observe its corpus, whatever it had done so far, and
  # a deploy recreating the container is the only thing that sends it here. Always indeterminate.
  [ "$1" -eq 137 ] && return 0
  container_up || return 0
  grep -qE 'Error response from daemon:.*(is not running|No such container)' "$2"
}

# A deploy is a NORMAL event on this host, not an outage: wait a bounded time for the container to
# come back rather than burning the rest of the venue list. Fails OPEN into INDETERMINATE.
CTR_WAIT_S="${HOLD_DRAIN_CTR_WAIT_S:-240}"
await_container() {
  local waited=0
  container_up && return 0
  while [ "$waited" -lt "$CTR_WAIT_S" ]; do
    sleep 10; waited=$((waited + 10))
    if container_up; then
      echo "$LOG_TAG container returned after ${waited}s (a deploy recreates it; this is expected)"
      return 0
    fi
  done
  return 1
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
  # leg_was_container_fault — the discriminator that the first live run proved was missing.
  # `container_up` is stubbed so the classifier is exercised in BOTH container states without a
  # docker daemon; the grep leg runs for real against a real temp file.
  tmpout=$(mktemp)
  printf 'Error response from daemon: container 70c1b9db is not running\n' > "$tmpout"
  cleanout=$(mktemp)
  printf 'HOLD_LABEL_VERDICT=FAIL {"considered":10,"written":0}\n' > "$cleanout"

  container_up() { return 0; }   # container UP
  leg_was_container_fault 0 "$tmpout";   check "rc=0 is never a container fault" 1 "$?"
  leg_was_container_fault 1 "$cleanout"; check "a real labeler FAIL stays a FAIL" 1 "$?"
  leg_was_container_fault 1 "$tmpout";   check "the daemon error is caught even if the container came back" 0 "$?"
  leg_was_container_fault 137 "$cleanout"; check "137 is ALWAYS indeterminate, never a failure" 0 "$?"
  container_up() { return 1; }   # container DOWN
  leg_was_container_fault 1 "$cleanout"; check "rc=1 with the container down is a container fault" 0 "$?"
  leg_was_container_fault 0 "$cleanout"; check "rc=0 stays clean even with the container down" 1 "$?"
  unset -f container_up
  rm -f "$tmpout" "$cleanout"

  # resolve_venues — the exclusions must be REFUSALS
  check "healthy venues resolve" "GATE HTX" "$(resolve_venues 'GATE,HTX')"
  resolve_venues 'GATE,HL' >/dev/null 2>&1; check "an excluded venue is refused" 2 "$?"
  check "OKX RESOLVES — its exclusion rested on one window and was re-measured" "OKX" "$(resolve_venues 'OKX')"
  resolve_venues 'HL'      >/dev/null 2>&1; check "HL is refused"                2 "$?"
  resolve_venues 'WEEX'    >/dev/null 2>&1; check "WEEX is refused"              2 "$?"
  resolve_venues ''        >/dev/null 2>&1; check "an empty set is refused"      2 "$?"
  # POSITIVE MEMBERSHIP, not just absence. The exclusion loop below proves excluded venues are
  # OUT; nothing proved a drained venue is IN, so a venue could vanish from DEFAULT_VENUES and the
  # suite would stay green. Found by mutation R2 while restoring OKX — the assertion set was
  # one-sided, which is the same shape as a guard that only checks the happy path.
  case ",$DEFAULT_VENUES," in
    *",OKX,"*) printf 'SELF-TEST: ok   OKX is IN the default set (its exclusion was re-measured)\n' ;;
    *) printf 'SELF-TEST: FAIL OKX missing from the default set\n'; fails=$((fails+1)) ;;
  esac
  # A floor, not an exact count: the set grows when a venue is promoted, and an equality check
  # would fail on that legitimate change while still catching a silent shrink.
  dv_n=$(printf '%s' "$DEFAULT_VENUES" | tr ',' ' ' | wc -w | tr -d ' ')
  if [ "$dv_n" -ge 13 ]; then printf 'SELF-TEST: ok   default set holds %s venues (floor 13)\n' "$dv_n"
  else printf 'SELF-TEST: FAIL default set shrank to %s venues (floor 13)\n' "$dv_n"; fails=$((fails+1)); fi

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

  # Re-checked EVERY leg, not once at the top: the pre-flight check answered a question about a
  # container that no longer exists by the time venue 3 runs.
  if ! await_container; then
    echo "$LOG_TAG [$v] SKIPPED — container $CTR down > ${CTR_WAIT_S}s. INDETERMINATE, not a failure."
    codes+=(3); continue
  fi

  legout=$(mktemp)
  docker exec "$CTR" node dist/scripts/backfill-hold-decision-labels.js \
    --venue "$v" --since "$SINCE_EPOCH" --require-parts --side sell \
    --per-cell "$PER_CELL" --max-decisions "$MAX_PER_VENUE" \
    --time-budget-min "$TIME_PER_VENUE_MIN" > "$legout" 2>&1
  rc=$?
  sed "s/^/$LOG_TAG [$v] /" "$legout"
  if leg_was_container_fault "$rc" "$legout"; then
    echo "$LOG_TAG [$v] rc=$rc was the CONTAINER, not the labeler — re-classified 3 (INDETERMINATE)"
    rc=3
  fi
  rm -f "$legout"
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
