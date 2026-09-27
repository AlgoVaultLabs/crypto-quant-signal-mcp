#!/usr/bin/env bash
# ads1-ch1-gate.sh — EDGE-ADS1-SCORECARD-W1-V2 CH1 (thin re-probe gate).
#
# Reads the CH1 addendum of the wave's endpoint-truth file and decides whether CH2 may start.
# The addendum carries exactly one line per probe, PROBE_<n>=<VALUE> for n = 1..10:
#   CONFIRMED   the probe re-observed what the spec's "What is true" section states
#   MEASURED    probe 4 only: reach + lane utilisation measured and a backfill plan written
#   DRIFT       the probe disagrees with the spec (new drift)  -> CH1_RED
#   UNMEASURED  the probe could not be run                      -> CH1_INDETERMINATE
#
# Verdict (exactly one terminal line, the token is the contract — never the exit code alone):
#   CH1_GREEN          exit 0   all ten lines present, every value CONFIRMED (probe 4 may be MEASURED)
#   CH1_RED            exit 1   any DRIFT
#   CH1_INDETERMINATE  exit 3   a line missing, duplicated with different values, unparseable,
#                               UNMEASURED, the addendum unreadable, or a required tool absent
# DRIFT outranks INDETERMINATE: a definitive disagreement is reported even when another line is unreadable.
#
# Written as a committed bash script on purpose: the Claude Code tool shell is zsh, where
# `${PIPESTATUS[0]}` is empty and `[ "" -eq 0 ]` is TRUE — a gate pasted there fails OPEN.
#
# Usage:
#   scripts/gates/ads1-ch1-gate.sh <addendum.md>      (or ADS1_CH1_ADDENDUM=<path>)
#   scripts/gates/ads1-ch1-gate.sh --self-test
set -uo pipefail

REQUIRED_TOOLS=(grep sed sort)

emit() { # <token> <exit> <reason>
  printf '[ads1-ch1-gate] %s\n' "$3" >&2
  printf '%s\n' "$1"
  exit "$2"
}

evaluate() { # <addendum path> -> prints the token, returns its exit code
  local path="$1" t
  for t in "${REQUIRED_TOOLS[@]}"; do
    command -v "$t" >/dev/null 2>&1 || emit CH1_INDETERMINATE 3 "required tool '$t' not on PATH"
  done
  [ -n "$path" ] || emit CH1_INDETERMINATE 3 "no addendum path given"
  [ -r "$path" ] || emit CH1_INDETERMINATE 3 "addendum not readable: $path"

  local drift=0 indeterminate=0 reasons="" n lines count value values
  for n in 1 2 3 4 5 6 7 8 9 10; do
    lines="$(grep -E "^PROBE_${n}=" "$path" || true)"
    if [ -z "$lines" ]; then
      indeterminate=1; reasons="$reasons PROBE_${n}:missing"; continue
    fi
    values="$(printf '%s\n' "$lines" | sed -E "s/^PROBE_${n}=([A-Z]+).*/\1/" | sort -u)"
    count="$(printf '%s\n' "$values" | grep -c .)"
    if [ "$count" -ne 1 ]; then
      indeterminate=1; reasons="$reasons PROBE_${n}:conflicting"; continue
    fi
    value="$values"
    case "$value" in
      CONFIRMED) ;;
      MEASURED)
        if [ "$n" -ne 4 ]; then indeterminate=1; reasons="$reasons PROBE_${n}:MEASURED-only-valid-for-probe-4"; fi ;;
      DRIFT) drift=1; reasons="$reasons PROBE_${n}:DRIFT" ;;
      UNMEASURED) indeterminate=1; reasons="$reasons PROBE_${n}:UNMEASURED" ;;
      *) indeterminate=1; reasons="$reasons PROBE_${n}:unparseable" ;;
    esac
  done

  if [ "$drift" -eq 1 ]; then emit CH1_RED 1 "new drift:$reasons"; fi
  if [ "$indeterminate" -eq 1 ]; then emit CH1_INDETERMINATE 3 "cannot verify:$reasons"; fi
  emit CH1_GREEN 0 "all ten probes re-confirmed"
}

self_test() {
  local tmp gate pass=0 fail=0 cases=0
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/ads1-ch1-selftest.XXXXXX")" || { echo "ADS1_CH1_GATE_SELFTEST: FAIL mktemp"; exit 1; }
  trap 'rm -rf "$tmp"' EXIT
  gate="${BASH_SOURCE[0]}"

  write_all() { # <file> [override lines...]
    local f="$1"; shift
    : >"$f"
    local n; for n in 1 2 3 5 6 7 8 9 10; do printf 'PROBE_%s=CONFIRMED\n' "$n" >>"$f"; done
    printf 'PROBE_4=MEASURED plan written\n' >>"$f"
    local l; for l in "$@"; do printf '%s\n' "$l" >>"$f"; done
  }
  check() { # <name> <expected token> <expected exit> <cmd...>
    local name="$1" want_tok="$2" want_rc="$3"; shift 3
    local out rc tok
    out="$("$@" 2>/dev/null)"; rc=$?
    tok="$(printf '%s\n' "$out" | tail -n 1)"
    cases=$((cases + 1))
    if [ "$tok" = "$want_tok" ] && [ "$rc" -eq "$want_rc" ]; then pass=$((pass + 1)); echo "SELF-TEST: ok $name"
    else fail=$((fail + 1)); echo "SELF-TEST: FAIL $name (got '$tok' rc=$rc, want '$want_tok' rc=$want_rc)"; fi
  }

  write_all "$tmp/green.md"
  check "all-confirmed-green" CH1_GREEN 0 bash "$gate" "$tmp/green.md"

  write_all "$tmp/drift.md" "PROBE_2=DRIFT count moved"
  sed -i.bak '/^PROBE_2=CONFIRMED/d' "$tmp/drift.md"
  check "synthetic-drift-red" CH1_RED 1 bash "$gate" "$tmp/drift.md"

  write_all "$tmp/missing.md"
  sed -i.bak '/^PROBE_7=/d' "$tmp/missing.md"
  check "missing-line-indeterminate" CH1_INDETERMINATE 3 bash "$gate" "$tmp/missing.md"

  write_all "$tmp/unmeasured.md" "PROBE_9=UNMEASURED"
  sed -i.bak '/^PROBE_9=CONFIRMED/d' "$tmp/unmeasured.md"
  check "unmeasured-indeterminate" CH1_INDETERMINATE 3 bash "$gate" "$tmp/unmeasured.md"

  write_all "$tmp/conflict.md" "PROBE_3=DRIFT"
  check "conflicting-duplicate-indeterminate" CH1_INDETERMINATE 3 bash "$gate" "$tmp/conflict.md"

  write_all "$tmp/garbage.md" "PROBE_5=MAYBE"
  sed -i.bak '/^PROBE_5=CONFIRMED/d' "$tmp/garbage.md"
  check "unparseable-indeterminate" CH1_INDETERMINATE 3 bash "$gate" "$tmp/garbage.md"

  write_all "$tmp/measured-wrong.md" "PROBE_6=MEASURED"
  sed -i.bak '/^PROBE_6=CONFIRMED/d' "$tmp/measured-wrong.md"
  check "measured-outside-probe4-indeterminate" CH1_INDETERMINATE 3 bash "$gate" "$tmp/measured-wrong.md"

  check "missing-file-indeterminate" CH1_INDETERMINATE 3 bash "$gate" "$tmp/does-not-exist.md"

  write_all "$tmp/drift-and-missing.md" "PROBE_1=DRIFT"
  sed -i.bak '/^PROBE_1=CONFIRMED/d;/^PROBE_8=/d' "$tmp/drift-and-missing.md"
  check "drift-outranks-missing" CH1_RED 1 bash "$gate" "$tmp/drift-and-missing.md"

  # a required tool absent: run with a PATH that holds only bash itself
  mkdir -p "$tmp/bin" && ln -s "$(command -v bash)" "$tmp/bin/bash"
  check "missing-tool-indeterminate" CH1_INDETERMINATE 3 env PATH="$tmp/bin" "$tmp/bin/bash" "$gate" "$tmp/green.md"
  # ...and it is the explicit precondition that said so, not a later accident of an empty grep
  cases=$((cases + 1))
  local errtxt
  errtxt="$(env PATH="$tmp/bin" "$tmp/bin/bash" "$gate" "$tmp/green.md" 2>&1 >/dev/null)"
  if printf '%s' "$errtxt" | grep -q "required tool 'grep'"; then
    pass=$((pass + 1)); echo "SELF-TEST: ok missing-tool-named"
  else fail=$((fail + 1)); echo "SELF-TEST: FAIL missing-tool-named (precondition did not report the absent tool)"; fi

  # vacuity guard: the corpus is constructed here, so zero cases is a defect of this test
  if [ "$cases" -lt 11 ]; then echo "ADS1_CH1_GATE_SELFTEST: FAIL vacuous ($cases cases)"; exit 1; fi
  if [ "$fail" -eq 0 ]; then echo "ADS1_CH1_GATE_SELFTEST: PASS ($pass checks)"; exit 0; fi
  echo "ADS1_CH1_GATE_SELFTEST: FAIL ($fail of $cases)"; exit 1
}

if [ "${1:-}" = "--self-test" ]; then self_test; fi
evaluate "${1:-${ADS1_CH1_ADDENDUM:-}}"
