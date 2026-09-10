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
#   hold-decision-drain.sh --timeframe 1d --per-cell 1 --max-decisions 800 --time-budget-min 25
#   hold-decision-drain.sh --conf-min 62 --conf-max 62
#
# ── THE CONFIDENCE PASSTHROUGH — EDGE-WITHHELD-COUNTERFACTUAL-DWR-W2 R1 ──────────────────
#
# SAME SHAPE, SAME REASONING, ONE WAVE LATER. `--conf-min` / `--conf-max` join the four flags
# below because W2 must drain a NAMED CONFIDENCE BAND, and without them this script cannot.
#
# MEASURED 2026-09-10, this script's own work-list (`rn <= 3`, unlabelled, `--require-parts`,
# SELL, `--since` capture-start), by withheld band:
#
#     atom (conf 62)   1,130 rows    1.0%
#     52-61            3,823         3.5%
#     45-51            5,731         5.2%
#     below-45       105,226        90.3%   <- already 17x over its cluster floor
#
# So 90.3% of an untargeted pass lands in the ONE band that needs nothing. Worse, `ROW_NUMBER`
# is computed over the UNFILTERED set, so a cell whose three oldest SELL rows are all below-45
# offers the atom NOTHING: the atom's entire reachable pool is those 1,130 rows, a ceiling of
# ~685 decided against a floor of 1,064. THE UNTARGETED DRAIN CANNOT REACH THAT FLOOR AT ANY
# BUDGET — a reach defect, not a budget one, and no `--max-decisions` repairs it.
#
# It also could not satisfy its own dispatch term ("`--max-decisions` above every leg's measured
# `--check` backlog, so the outer `ORDER BY` never truncates"): the unfiltered backlog is
# 107,637 decisions across 13 venues, which does not fit one deploy-free window at MEXC's
# measured 10.6 cells/min. Band-filtered it is 3,862 / 14,949 / 22,136 — and because the filter
# sits INSIDE the CTE, `ROW_NUMBER` then partitions the BAND, so per-cell breadth is per-band.
#
# `backfill-hold-decision-labels.ts` has carried `--conf-min` / `--conf-max` since
# EDGE-WITHHELD-COUNTERFACTUAL-DWR-W1 R2; as with `--timeframe`, the gap was only here. The
# alternative — a wave-specific launcher calling the labeler directly — is REFUSED for exactly
# the reason recorded below: a second derivation of `combine_verdict` / `leg_was_container_fault`
# is the copy nobody watches.
#
# BOUNDS ARE REFUSED, NEVER PASSED THROUGH, and the three refusals READ DIFFERENTLY because they
# need different fixes: a non-integer, an out-of-range value, and an INVERTED pair
# (`--conf-min` > `--conf-max`). The last matters most: the labeler would accept it, return an
# empty work-list, and print a clean zero-row PASS — indistinguishable from "there was nothing
# left to label", the exact pair the token contract exists to keep apart.
#
# ── THE FOUR PASSTHROUGH FLAGS — EDGE-SELL-ATTRIBUTION-CENTERED-CHECK-W2 R1 ─────────────
#
# `--timeframe` / `--per-cell` / `--max-decisions` / `--time-budget-min` set the SAME four
# variables the `HOLD_DRAIN_*` env vars already set, so there is ONE derivation of each knob and
# the flag simply wins over the env. They exist because W2 must drain a NAMED timeframe: W1's
# untargeted pass reached ZERO 12h and 1d rows, and this script had no way to ask for them.
#
# `backfill-hold-decision-labels.ts` has carried `--timeframe` since it was written; the gap was
# only here. The alternative — a wave-specific launcher calling the labeler directly — was
# REFUSED: it would give `combine_verdict` and `leg_was_container_fault` a second derivation, and
# a second copy of a verdict contract is the copy nobody watches.
#
# With every flag absent the emitted `docker exec` argv is BYTE-IDENTICAL to the pre-flag one:
# `--timeframe` is appended only when set, exactly as the labeler's own optional filters are.
#
# An UNKNOWN timeframe is REFUSED through this script's existing exit-3 / INDETERMINATE contract,
# never thrown and never passed through. The labeler would accept any string and silently return
# an empty work-list, which is indistinguishable from "there was nothing left to label" — the
# exact pair the token contract exists to keep apart.
set -uo pipefail

CTR="${HOLD_DRAIN_CTR:-crypto-quant-signal-mcp-mcp-server-1}"
LOG_TAG="[hold-decision-drain]"

# Same epoch and same asymmetry as the nightly: `--require-parts` is authoritative, so a stale
# value here costs query time and never correctness.
SINCE_EPOCH="${HOLD_DRAIN_SINCE_EPOCH:-1788172475}"
PER_CELL="${HOLD_DRAIN_PER_CELL:-3}"
MAX_PER_VENUE="${HOLD_DRAIN_MAX_PER_VENUE:-1500}"
TIME_PER_VENUE_MIN="${HOLD_DRAIN_TIME_PER_VENUE_MIN:-12}"

# Empty = every timeframe, the pre-W2 behaviour. Set = one named timeframe per invocation.
TIMEFRAME="${HOLD_DRAIN_TIMEFRAME:-}"

# Empty = every confidence, the pre-DWR-W2 behaviour. Set = one bound per invocation. Either may
# be set without the other, exactly as the labeler treats them.
CONF_MIN="${HOLD_DRAIN_CONF_MIN:-}"
CONF_MAX="${HOLD_DRAIN_CONF_MAX:-}"

# `hold_decisions.confidence` is a smallint the scorer emits on a 0-100 scale. The bound is
# DECLARED here rather than inferred from the data, for the same reason KNOWN_TIMEFRAMES is: a
# range derived from "what the table currently holds" silently narrows the day the scorer's own
# range moves, and the caller would never learn that the bound they asked for was clipped.
CONF_SCALE_MIN=0
CONF_SCALE_MAX=100

# DECLARED, never inferred. Mirrors `EVAL_CANDLES` in src/lib/pfe-mae.ts, which is the one table
# that decides whether a row's barrier window can close at all — a timeframe absent from it has
# no horizon and the labeler's `windowClosed` returns false for it forever.
#
# `1m` is deliberately NOT here and is refused BY NAME below: `buildEligibleWhere` hardcodes
# `h.timeframe <> '1m'` (the retired lane, OPS-1M-SEED-DECOM-W1), so a `--timeframe 1m` run would
# be admitted by this script, rejected by the query, and report a clean zero-row PASS.
KNOWN_TIMEFRAMES="3m,5m,15m,30m,1h,2h,4h,8h,12h,1d"
RETIRED_TIMEFRAMES="1m"

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

# The declared timeframe set. Empty input is the DEFAULT (every timeframe), not an error — the
# asymmetry with `resolve_venues` is deliberate and is the whole difference between the two: an
# empty VENUE set means the caller asked for nothing, while an empty TIMEFRAME means the caller
# did not narrow. A retired lane is refused with its own reason rather than folded into "unknown",
# because the two need different fixes.
resolve_timeframe() {
  local tf="$1"
  [ -z "$tf" ] && { printf ''; return 0; }
  case ",$RETIRED_TIMEFRAMES," in
    *",$tf,"*) printf 'REFUSED %s — retired lane; the work-list excludes it by construction\n' "$tf" >&2; return 2 ;;
  esac
  case ",$KNOWN_TIMEFRAMES," in
    *",$tf,"*) printf '%s' "$tf"; return 0 ;;
  esac
  printf 'REFUSED %s — not in the declared set (%s)\n' "$tf" "$KNOWN_TIMEFRAMES" >&2
  return 2
}

# A caller error is "could not observe", never "observed a failure" — so a non-numeric or
# non-positive knob is refused HERE with the script's 3, rather than passed down to the labeler
# where `posInt` would throw and the leg would be scored FAIL. One derivation, three consumers.
resolve_posint() {  # <name> <value>
  case "$2" in
    ''|*[!0-9]*) printf 'REFUSED %s=%s — must be a positive integer\n' "$1" "$2" >&2; return 2 ;;
  esac
  [ "$2" -ge 1 ] || { printf 'REFUSED %s=%s — must be >= 1\n' "$1" "$2" >&2; return 2; }
  printf '%s' "$2"
}

# A confidence bound is NOT a posInt: 0 is a legitimate lower bound ("no floor") while
# `resolve_posint` refuses it, and a confidence has an UPPER bound that a count does not. Reusing
# resolve_posint would therefore refuse a valid `--conf-min 0` and accept a meaningless
# `--conf-max 5000`, so this is a separate predicate rather than a widened one.
#
# EMPTY resolves to empty — the DEFAULT (no bound), the same asymmetry `resolve_timeframe` has
# against `resolve_venues`: an empty bound means the caller did not narrow, not that they asked
# for nothing.
#
# The two refusals READ DIFFERENTLY on purpose. Found by the same mutation that found the
# retired-lane hole: a range check and a numeric check can share an exit code while needing
# different fixes, so the CODE alone asserts nothing and the REASON is what the self-test pins.
resolve_conf() {  # <name> <value>
  local name="$1" v="$2"
  [ -z "$v" ] && { printf ''; return 0; }
  case "$v" in
    *[!0-9]*) printf 'REFUSED %s=%s — must be an integer\n' "$name" "$v" >&2; return 2 ;;
  esac
  if [ "$v" -lt "$CONF_SCALE_MIN" ] || [ "$v" -gt "$CONF_SCALE_MAX" ]; then
    printf 'REFUSED %s=%s — outside the declared confidence scale (%s..%s)\n' \
      "$name" "$v" "$CONF_SCALE_MIN" "$CONF_SCALE_MAX" >&2
    return 2
  fi
  printf '%s' "$v"
}

# AN INVERTED PAIR IS ITS OWN REFUSAL, and it is the one that actually costs something.
# `--conf-min 62 --conf-max 45` is accepted by the labeler, matches nothing, and prints a clean
# zero-row PASS — indistinguishable from "there was nothing left to label". That is precisely the
# pair this script's token contract exists to keep apart, so it is refused HERE, by name.
# A bound set on only one side is NOT an inversion and stays legal.
resolve_conf_pair() {  # <min> <max>  -> 0 legal, 2 inverted
  [ -n "$1" ] && [ -n "$2" ] || return 0
  [ "$1" -le "$2" ] && return 0
  printf 'REFUSED --conf-min=%s > --conf-max=%s — an inverted band matches nothing and would report a zero-row PASS\n' \
    "$1" "$2" >&2
  return 2
}

# THE REAL APPENDER, extracted so the self-test cannot be blind to it.
#
# A hermetic self-test is structurally blind to exactly what its own seam replaces, and a
# self-test that rebuilds the argv with its own local helper asserts only that the HELPER agrees
# with itself. The byte-identity property this flag ships on lives in THIS function, so this
# function is what the self-test calls. (`$TF_FLAG` predates the lesson and keeps its inline
# form; a second consumer of that shape would be the moment to extract it too.)
conf_flags() {  # <min> <max> -> the argv fragment, empty when neither bound is set
  local lo="$1" hi="$2" f=""
  [ -n "$lo" ] && f="--conf-min $lo"
  [ -n "$hi" ] && f="${f:+$f }--conf-max $hi"
  printf '%s' "$f"
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
  # ── W2 R1 passthrough — resolve_timeframe ─────────────────────────────────────────────────
  # An unknown timeframe must REFUSE through the exit-3 contract, never reach the labeler: the
  # labeler would accept any string, return an empty work-list, and print a clean zero-row PASS
  # that is indistinguishable from "there was nothing left to label".
  check "a declared timeframe resolves"          "1d"  "$(resolve_timeframe '1d')"
  check "the coarsest declared timeframe resolves" "12h" "$(resolve_timeframe '12h')"
  check "EMPTY resolves to empty — the DEFAULT, not an error" "" "$(resolve_timeframe '')"
  resolve_timeframe ''    >/dev/null 2>&1; check "and empty exits 0, unlike an empty venue set" 0 "$?"
  resolve_timeframe '2d'  >/dev/null 2>&1; check "an undeclared timeframe is refused"           2 "$?"
  resolve_timeframe '1D'  >/dev/null 2>&1; check "the set is case-SENSITIVE — '1D' is refused"   2 "$?"
  resolve_timeframe '1d,12h' >/dev/null 2>&1; check "a LIST is refused — one timeframe per leg"  2 "$?"
  resolve_timeframe '1m'  >/dev/null 2>&1; check "the retired 1m lane is refused"               2 "$?"
  # ASSERT THE REASON, NOT THE CODE. Found by mutation: deleting the retired-lane branch entirely
  # left every exit code unchanged, because `1m` is absent from KNOWN_TIMEFRAMES and the
  # fall-through refuses it too. Two mechanisms, one code — so the code alone asserts nothing.
  # A retired lane and an unknown string need DIFFERENT fixes, so they must read differently.
  check "and refused with the RETIRED reason, not the unknown one" "retired" \
    "$(resolve_timeframe '1m' 2>&1 >/dev/null | grep -o 'retired' | head -1)"
  check "an undeclared timeframe gives the UNKNOWN reason"         "declared set" \
    "$(resolve_timeframe '2d' 2>&1 >/dev/null | grep -o 'declared set' | head -1)"
  # POSITIVE MEMBERSHIP over the whole declared set, not just two samples: the same one-sided
  # gap that R2 found in the venue rows would let a timeframe silently vanish from the set.
  tf_missing=0
  for tf in ${KNOWN_TIMEFRAMES//,/ }; do
    [ "$(resolve_timeframe "$tf")" = "$tf" ] || tf_missing=$((tf_missing+1))
  done
  check "every declared timeframe resolves to itself" 0 "$tf_missing"
  # the declared set and the retired list must not disagree — same rule the venue rows enforce
  for tf in ${RETIRED_TIMEFRAMES//,/ }; do
    case ",$KNOWN_TIMEFRAMES," in
      *",$tf,"*) printf 'SELF-TEST: FAIL declared set contains retired timeframe %s\n' "$tf"; fails=$((fails+1)) ;;
      *) printf 'SELF-TEST: ok   declared set excludes retired %s\n' "$tf" ;;
    esac
  done
  # A floor, not an equality: the set grows when a lane is added, and an equality check would go
  # red on that legitimate change while still catching a silent shrink.
  tf_n=$(printf '%s' "$KNOWN_TIMEFRAMES" | tr ',' ' ' | wc -w | tr -d ' ')
  if [ "$tf_n" -ge 10 ]; then printf 'SELF-TEST: ok   declared set holds %s timeframes (floor 10)\n' "$tf_n"
  else printf 'SELF-TEST: FAIL declared set shrank to %s timeframes (floor 10)\n' "$tf_n"; fails=$((fails+1)); fi

  # ── W2 R1 passthrough — resolve_posint ────────────────────────────────────────────────────
  # A caller typo is "could not observe", not "observed a failure"; it must not reach the
  # labeler's posInt, where a throw would score the leg FAIL.
  check "a positive integer resolves"    "25" "$(resolve_posint TIME_PER_VENUE_MIN 25)"
  check "one is the smallest accepted"    "1" "$(resolve_posint PER_CELL 1)"
  resolve_posint PER_CELL 0     >/dev/null 2>&1; check "zero is refused"          2 "$?"
  resolve_posint PER_CELL -1    >/dev/null 2>&1; check "a negative is refused"    2 "$?"
  resolve_posint PER_CELL 1.5   >/dev/null 2>&1; check "a decimal is refused"     2 "$?"
  resolve_posint PER_CELL abc   >/dev/null 2>&1; check "a non-number is refused"  2 "$?"
  resolve_posint PER_CELL ''    >/dev/null 2>&1; check "an empty value is refused" 2 "$?"
  # ASSERT THE REASON HERE TOO, for the same measured cause. Deleting the numeric branch left all
  # five rows green: `[ abc -ge 1 ]` is a bash ERROR that also returns non-zero, so the refusal
  # survived by accident with no message and no meaning. A guard whose failure mode is an
  # interpreter error is not a guard.
  check "a non-number gives the numeric reason"  "positive integer" \
    "$(resolve_posint PER_CELL abc 2>&1 >/dev/null | grep -o 'positive integer' | head -1)"
  check "a decimal gives the numeric reason"     "positive integer" \
    "$(resolve_posint PER_CELL 1.5 2>&1 >/dev/null | grep -o 'positive integer' | head -1)"
  check "an empty value gives the numeric reason" "positive integer" \
    "$(resolve_posint PER_CELL '' 2>&1 >/dev/null | grep -o 'positive integer' | head -1)"
  check "zero gives the FLOOR reason, not the numeric one" ">= 1" \
    "$(resolve_posint PER_CELL 0 2>&1 >/dev/null | grep -o '>= 1' | head -1)"

  # ── W2 R1 passthrough — the argv must stay byte-identical with no --timeframe ──────────────
  # This is the property that lets the flag ship without re-baselining anything: the default
  # invocation must emit exactly the argv it emitted before the flag existed.
  tf_argv() { local tf="$1" f=""; [ -n "$tf" ] && f="--timeframe $tf"; printf '%s' "--side sell $f --per-cell 1"; }
  check "no timeframe => argv unchanged" "--side sell  --per-cell 1" "$(tf_argv '')"
  check "a timeframe => argv carries it" "--side sell --timeframe 1d --per-cell 1" "$(tf_argv '1d')"
  unset -f tf_argv

  # ── DWR-W2 R1 passthrough — resolve_conf ──────────────────────────────────────────────────
  # A confidence bound is not a posInt: 0 is legal here and refused there, and there is an UPPER
  # bound a count does not have. Both directions are asserted, because a predicate that only
  # rejects is the one-sided shape R2 already found in the venue rows.
  check "a bound inside the scale resolves"        "62" "$(resolve_conf --conf-min 62)"
  check "ZERO is a legal lower bound, unlike posInt" "0" "$(resolve_conf --conf-min 0)"
  check "the scale ceiling resolves"              "100" "$(resolve_conf --conf-max 100)"
  check "EMPTY resolves to empty — the DEFAULT, not an error" "" "$(resolve_conf --conf-min '')"
  resolve_conf --conf-min ''   >/dev/null 2>&1; check "and empty exits 0, like a timeframe"   0 "$?"
  resolve_conf --conf-min 101  >/dev/null 2>&1; check "above the scale is refused"            2 "$?"
  resolve_conf --conf-max -1   >/dev/null 2>&1; check "a negative is refused"                 2 "$?"
  resolve_conf --conf-min 6.5  >/dev/null 2>&1; check "a decimal is refused"                  2 "$?"
  resolve_conf --conf-min abc  >/dev/null 2>&1; check "a non-number is refused"               2 "$?"
  resolve_conf --conf-min 45,51 >/dev/null 2>&1; check "a LIST is refused — one bound per flag" 2 "$?"
  # ASSERT THE REASON, NOT THE CODE — the same mutation lesson the timeframe and posint rows
  # carry. Deleting the range branch leaves every exit code unchanged, because `101` is caught by
  # nothing else and `-1` is caught by the numeric branch (the `-` is a non-digit). Two
  # mechanisms, one code, so the code alone asserts nothing — and a caller who typed a value
  # outside the scale needs a different fix from one who typed a word.
  check "an out-of-scale value gives the SCALE reason, not the numeric one" "confidence scale" \
    "$(resolve_conf --conf-min 101 2>&1 >/dev/null | grep -o 'confidence scale' | head -1)"
  check "a non-number gives the INTEGER reason"    "must be an integer" \
    "$(resolve_conf --conf-min abc 2>&1 >/dev/null | grep -o 'must be an integer' | head -1)"
  # POSITIVE MEMBERSHIP over the whole declared scale, sampled at both ends and the interior, so
  # a silently narrowed CONF_SCALE_* is caught rather than assumed.
  conf_missing=0
  for c in 0 1 44 45 51 52 61 62 99 100; do
    [ "$(resolve_conf --conf-min "$c")" = "$c" ] || conf_missing=$((conf_missing+1))
  done
  check "every in-scale sample resolves to itself" 0 "$conf_missing"

  # ── DWR-W2 R1 — an INVERTED band is its own refusal ────────────────────────────────────────
  # THE ROW THAT EARNS ITS KEEP. `--conf-min 62 --conf-max 45` is accepted by the labeler, matches
  # nothing, and prints a clean zero-row PASS that reads exactly like "nothing left to label".
  resolve_conf_pair 62 45 >/dev/null 2>&1; check "an inverted band is refused"          2 "$?"
  resolve_conf_pair 45 62 >/dev/null 2>&1; check "an ordered band is legal"             0 "$?"
  resolve_conf_pair 62 62 >/dev/null 2>&1; check "a single-value band is legal"         0 "$?"
  resolve_conf_pair 62 '' >/dev/null 2>&1; check "min alone is legal — not an inversion" 0 "$?"
  resolve_conf_pair '' 45 >/dev/null 2>&1; check "max alone is legal — not an inversion" 0 "$?"
  resolve_conf_pair '' '' >/dev/null 2>&1; check "neither bound is legal"               0 "$?"
  check "and the inversion names the zero-row PASS it prevents" "zero-row PASS" \
    "$(resolve_conf_pair 62 45 2>&1 >/dev/null | grep -o 'zero-row PASS' | head -1)"

  # ── DWR-W2 R1 — the argv must stay byte-identical with NEITHER bound set ───────────────────
  # Same property as the timeframe block above, and the reason it is asserted separately: the two
  # bounds are appended INDEPENDENTLY, so "both absent" and "one absent" are different shapes and
  # a single assertion would cover neither pair.
# It calls the REAL `conf_flags` — the function the live `docker exec` line interpolates — rather
  # than a local rebuild of it, so the seam is exercised instead of replaced.
  cf_argv() { printf '%s' "--side sell $(conf_flags "$1" "$2") --per-cell 1"; }
  check "no bounds => argv unchanged"    "--side sell  --per-cell 1"                  "$(cf_argv '' '')"
  check "both bounds => argv carries both" "--side sell --conf-min 45 --conf-max 51 --per-cell 1" "$(cf_argv 45 51)"
  check "min only => argv carries min"   "--side sell --conf-min 62 --per-cell 1"     "$(cf_argv 62 '')"
  check "max only => argv carries max"   "--side sell --conf-max 44 --per-cell 1"     "$(cf_argv '' 44)"
  unset -f cf_argv

  # vacuity: this corpus is one WE construct, so an empty one means the test built nothing
  if [ -z "$DEFAULT_VENUES" ]; then
    printf 'SELF-TEST: FAIL default venue set is empty\n'; fails=$((fails+1))
  fi
  if [ -z "$KNOWN_TIMEFRAMES" ]; then
    printf 'SELF-TEST: FAIL declared timeframe set is empty\n'; fails=$((fails+1))
  fi
  # The confidence scale is ours too, and an inverted or empty one would make every resolve_conf
  # row above vacuous while leaving them all green.
  if [ "$CONF_SCALE_MIN" -ge "$CONF_SCALE_MAX" ]; then
    printf 'SELF-TEST: FAIL declared confidence scale is empty or inverted (%s..%s)\n' \
      "$CONF_SCALE_MIN" "$CONF_SCALE_MAX"; fails=$((fails+1))
  fi
  printf 'HOLD_DRAIN_SELFTEST=%s failures=%s\n' "$([ "$fails" -eq 0 ] && echo PASS || echo FAIL)" "$fails"
  [ "$fails" -eq 0 ] && exit 0 || exit 1
fi

# ── live ─────────────────────────────────────────────────────────────────────────────────────

DRY_RUN=0
VENUES_REQ="$DEFAULT_VENUES"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)        DRY_RUN=1; shift ;;
    --venues)         VENUES_REQ="${2:-}"; shift 2 ;;
    --timeframe)      TIMEFRAME="${2:-}"; shift 2 ;;
    --per-cell)       PER_CELL="${2:-}"; shift 2 ;;
    --max-decisions)  MAX_PER_VENUE="${2:-}"; shift 2 ;;
    --time-budget-min) TIME_PER_VENUE_MIN="${2:-}"; shift 2 ;;
    --conf-min)       CONF_MIN="${2:-}"; shift 2 ;;
    --conf-max)       CONF_MAX="${2:-}"; shift 2 ;;
    *) echo "$LOG_TAG unknown argument '$1'" >&2
       echo "HOLD_DRAIN_VERDICT=INDETERMINATE"; exit 3 ;;
  esac
done

# Every knob is validated BEFORE the container check, so a typo costs nothing and cannot be
# mistaken for a venue budget or a deploy.
if ! TIMEFRAME=$(resolve_timeframe "$TIMEFRAME"); then
  echo "$LOG_TAG refusing: --timeframe is not in the declared set ($KNOWN_TIMEFRAMES)" >&2
  echo "HOLD_DRAIN_VERDICT=INDETERMINATE"; exit 3
fi
for _knob in "PER_CELL:$PER_CELL" "MAX_PER_VENUE:$MAX_PER_VENUE" "TIME_PER_VENUE_MIN:$TIME_PER_VENUE_MIN"; do
  if ! resolve_posint "${_knob%%:*}" "${_knob#*:}" >/dev/null; then
    echo "$LOG_TAG refusing: ${_knob%%:*} is not a positive integer" >&2
    echo "HOLD_DRAIN_VERDICT=INDETERMINATE"; exit 3
  fi
done

if ! CONF_MIN=$(resolve_conf --conf-min "$CONF_MIN"); then
  echo "$LOG_TAG refusing: --conf-min is not an integer inside $CONF_SCALE_MIN..$CONF_SCALE_MAX" >&2
  echo "HOLD_DRAIN_VERDICT=INDETERMINATE"; exit 3
fi
if ! CONF_MAX=$(resolve_conf --conf-max "$CONF_MAX"); then
  echo "$LOG_TAG refusing: --conf-max is not an integer inside $CONF_SCALE_MIN..$CONF_SCALE_MAX" >&2
  echo "HOLD_DRAIN_VERDICT=INDETERMINATE"; exit 3
fi
if ! resolve_conf_pair "$CONF_MIN" "$CONF_MAX"; then
  echo "$LOG_TAG refusing: --conf-min > --conf-max — an inverted band reports a zero-row PASS" >&2
  echo "HOLD_DRAIN_VERDICT=INDETERMINATE"; exit 3
fi

# Appended only when set, so with no --timeframe the emitted argv is byte-identical to pre-W2.
TF_FLAG=""
[ -n "$TIMEFRAME" ] && TF_FLAG="--timeframe $TIMEFRAME"

# Same rule, same reason: with both bounds absent the emitted argv is byte-identical to the
# pre-DWR-W2 one, and each bound is appended INDEPENDENTLY because the labeler accepts either
# alone. Unquoted on the docker exec line exactly as $TF_FLAG is — the values are integers this
# script has already validated, never caller text reaching the shell unchecked.
CONF_FLAGS="$(conf_flags "$CONF_MIN" "$CONF_MAX")"

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
     "max_per_venue=$MAX_PER_VENUE time_per_venue_min=$TIME_PER_VENUE_MIN dry_run=$DRY_RUN" \
     "timeframe=${TIMEFRAME:-<all>} conf_min=${CONF_MIN:-<none>} conf_max=${CONF_MAX:-<none>}"
echo "$LOG_TAG venues=$VENUES"
echo "$LOG_TAG excluded=$EXCLUDED_VENUES (measured batch saturation / open HL observation window)"

codes=()
for v in $VENUES; do
  before=$(parse_ledger "$(ledger_of "$v")")
  # --check first: the per-venue backlog, and the --require-parts vs --since disagreement count.
  docker exec "$CTR" node dist/scripts/backfill-hold-decision-labels.js --check \
    --venue "$v" --since "$SINCE_EPOCH" --require-parts --side sell $TF_FLAG $CONF_FLAGS \
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
    --venue "$v" --since "$SINCE_EPOCH" --require-parts --side sell $TF_FLAG $CONF_FLAGS \
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
