#!/usr/bin/env bash
# ads1-ch3-gate.sh — EDGE-ADS1-SCORECARD-W1-V2 CH3 (registration, read-only extract, scorecard).
#
# Reads the PRIVATE vault audit the scorecard wrote (its .md and the .json beside it) and the git history
# of this checkout. Nothing here reads a figure into the repo or prints one.
#
#   GREEN iff  the audit exists
#          ∧  its terminal line is `ADS1_SCORECARD_SELFCHECK: PASS (<k> checks)`
#          ∧  no `verdict: EXCEPTIONAL` anywhere in it
#          ∧  the registration commit it names EXISTS here, is an ancestor of origin/main (it LANDED),
#             CONTAINS the registration file the audit names, and its committer timestamp — read from git,
#             not from the audit — precedes the recorded pull start
#          ∧  every session part's token is `current_user=aoe_readonly transaction_read_only=on` (≥ 4 parts)
#
# Verdict — exactly one terminal line, the token is the contract:
#   CH3_GREEN          exit 0
#   CH3_RED            exit 1   any check failed
#   CH3_INDETERMINATE  exit 3   the audit (or its .json) is missing, a tool is missing, or git cannot
#                               resolve the registration commit (cannot verify ≠ verified clean)
#
# A committed bash script on purpose (the tool shell is zsh: ${PIPESTATUS[0]} is empty and fails open).
# --self-test drives the REAL decision function (the script is sourceable) over synthetic audits in a
# temp dir, against this checkout's real HEAD commit, plus a PATH-stripped run for the missing tool.
#
# Usage:  scripts/gates/ads1-ch3-gate.sh <audit.md>          (the .json is <audit>.json beside it)
#         scripts/gates/ads1-ch3-gate.sh --self-test
set -uo pipefail

REQUIRED_TOOLS=(node git grep tail wc tr)
RO_TOKEN='TOKEN current_user=aoe_readonly transaction_read_only=on'

# check_audit <audit.md> <remote-ref>  -> prints the token, returns its code
check_audit() {
  local md="$1" ref="$2" json="${1%.md}.json"
  if [ ! -r "$md" ] || [ ! -r "$json" ]; then
    printf '[ads1-ch3-gate] audit or its json missing: %s / %s\n' "$md" "$json" >&2
    echo CH3_INDETERMINATE; return 3
  fi
  local red="" last facts commit pull ts tokens_ok
  last="$(grep -v '^[[:space:]]*$' "$md" | tail -n 1)"
  case "$last" in
    "ADS1_SCORECARD_SELFCHECK: PASS ("*" checks)") ;;
    *) red="$red selfcheck:'${last:0:80}'" ;;
  esac
  if grep -q 'verdict: EXCEPTIONAL' "$md"; then red="$red exceptional-verdict"; fi
  facts="$(node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const g = j.generatedFrom || {};
    const ro = process.argv[2];
    const t = Array.isArray(g.tokenLines) ? g.tokenLines : [];
    const ok = t.length >= 4 && t.every((x) => x === ro);
    console.log([g.registrationCommit || "", Number(g.pullStartTs) || 0, ok ? "yes" : "no", g.registrationPath || ""].join(" "));
  ' "$json" "$RO_TOKEN" 2>/dev/null)" || facts=""
  if [ -z "$facts" ]; then
    printf '[ads1-ch3-gate] the audit json is unreadable\n' >&2
    echo CH3_INDETERMINATE; return 3
  fi
  read -r commit pull tokens_ok regpath <<EOF
$facts
EOF
  [ "$tokens_ok" = "yes" ] || red="$red token"
  # occurrences, not lines: the audit prints the four tokens on one provenance line
  [ "$(grep -o "$RO_TOKEN" "$md" | wc -l | tr -d ' ')" -ge 4 ] || red="$red token-in-md"
  if [ -z "$commit" ] || ! ts="$(git log -1 --format=%ct "$commit" 2>/dev/null)" || [ -z "$ts" ]; then
    printf '[ads1-ch3-gate] git cannot resolve the registration commit %s\n' "${commit:-<none>}" >&2
    [ -n "$red" ] && { printf '[ads1-ch3-gate] RED:%s\n' "$red" >&2; echo CH3_RED; return 1; }
    echo CH3_INDETERMINATE; return 3
  fi
  git merge-base --is-ancestor "$commit" "$ref" 2>/dev/null || red="$red registration-not-landed"
  # the named commit must CONTAIN the named registration — else any old landed commit would pass
  case "$regpath" in
    audits/*preregistration*.md) git cat-file -e "$commit:$regpath" 2>/dev/null || red="$red registration-file-not-in-commit" ;;
    *) red="$red registration-path:'${regpath:-none}'" ;;
  esac
  [ "$ts" -lt "$pull" ] || red="$red registration-after-pull($ts>=$pull)"
  if [ -n "$red" ]; then printf '[ads1-ch3-gate] RED:%s\n' "$red" >&2; echo CH3_RED; return 1; fi
  printf '[ads1-ch3-gate] self-check PASS · no EXCEPTIONAL · registration %s landed at %s < pull %s · RO tokens\n' "$commit" "$ts" "$pull" >&2
  echo CH3_GREEN; return 0
}

run_gate() {
  local t
  for t in "${REQUIRED_TOOLS[@]}"; do
    command -v "$t" >/dev/null 2>&1 || { printf "[ads1-ch3-gate] required tool '%s' not on PATH\n" "$t" >&2; echo CH3_INDETERMINATE; exit 3; }
  done
  [ -n "${1:-}" ] || { echo "[ads1-ch3-gate] usage: $0 <audit.md>" >&2; echo CH3_INDETERMINATE; exit 3; }
  local root; root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo CH3_INDETERMINATE; exit 3; }
  cd "$root" || { echo CH3_INDETERMINATE; exit 3; }
  local def; def="$(git symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null || echo refs/remotes/origin/main)"
  check_audit "$1" "$def"
  exit $?
}

self_test() {
  local pass=0 fail=0 cases=0 tmp
  cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)" || { echo "ADS1_CH3_GATE_SELFTEST: FAIL not in a checkout"; exit 1; }
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/ads1-ch3-selftest.XXXXXX")" || { echo "ADS1_CH3_GATE_SELFTEST: FAIL mktemp"; exit 1; }
  local head ts; head="$(git rev-parse HEAD)"; ts="$(git log -1 --format=%ct HEAD)"
  local REG; REG="$(git ls-tree --name-only HEAD audits/ | grep -m 1 'preregistration.*\.md$')"
  [ -n "$REG" ] || { echo "ADS1_CH3_GATE_SELFTEST: FAIL no registration in HEAD to build fixtures from"; exit 1; }
  # fixture <name> <selfcheck line> <extra md line> <commit> <pull ts> <tokens json array>
  fixture() {
    local d="$tmp/$1"; mkdir -p "$d"
    printf '# audit\n\n- Read-only tokens: `%s` · `%s` · `%s` · `%s`\n%s\n\n%s\n' "$RO_TOKEN" "$RO_TOKEN" "$RO_TOKEN" "$RO_TOKEN" "$3" "$2" > "$d/a.md"
    printf '{"generatedFrom":{"registrationCommit":"%s","pullStartTs":%s,"tokenLines":%s,"registrationPath":"%s"}}\n' "$4" "$5" "$6" "${7:-$REG}" > "$d/a.json"
    echo "$d/a.md"
  }
  check() { # <name> <want token> <want rc> <md> <ref>
    local out rc
    out="$(check_audit "$4" "$5" 2>/dev/null)"; rc=$?
    cases=$((cases + 1))
    if [ "$out" = "$2" ] && [ "$rc" -eq "$3" ]; then pass=$((pass + 1)); echo "SELF-TEST: ok $1"
    else fail=$((fail + 1)); echo "SELF-TEST: FAIL $1 (got '$out' rc=$rc, want '$2' rc=$3)"; fi
  }
  local OK='ADS1_SCORECARD_SELFCHECK: PASS (13 checks)' T4="[\"$RO_TOKEN\",\"$RO_TOKEN\",\"$RO_TOKEN\",\"$RO_TOKEN\"]"
  local later=$((ts + 60)) earlier=$((ts - 60))
  check all-good-green CH3_GREEN 0 "$(fixture good "$OK" '- verdict: NO_CLAIM' "$head" "$later" "$T4")" HEAD
  check audit-missing-indeterminate CH3_INDETERMINATE 3 "$tmp/nowhere/a.md" HEAD
  check json-missing-indeterminate CH3_INDETERMINATE 3 "$(d="$tmp/nojson"; mkdir -p "$d"; printf '%s\n' "$OK" > "$d/a.md"; echo "$d/a.md")" HEAD
  check selfcheck-fail-red CH3_RED 1 "$(fixture sfail 'ADS1_SCORECARD_SELFCHECK: FAIL pooled identity' '' "$head" "$later" "$T4")" HEAD
  check selfcheck-not-terminal-red CH3_RED 1 "$(fixture notlast "$OK" '' "$head" "$later" "$T4"; printf 'trailing prose\n' >> "$tmp/notlast/a.md")" HEAD
  check exceptional-red CH3_RED 1 "$(fixture exc "$OK" '- verdict: EXCEPTIONAL' "$head" "$later" "$T4")" HEAD
  check registration-after-pull-red CH3_RED 1 "$(fixture late "$OK" '' "$head" "$earlier" "$T4")" HEAD
  check registration-same-second-red CH3_RED 1 "$(fixture same "$OK" '' "$head" "$ts" "$T4")" HEAD
  check writer-token-red CH3_RED 1 "$(fixture writer "$OK" '' "$head" "$later" "[\"$RO_TOKEN\",\"TOKEN current_user=algovault_app transaction_read_only=off\",\"$RO_TOKEN\",\"$RO_TOKEN\"]")" HEAD
  check too-few-tokens-red CH3_RED 1 "$(fixture few "$OK" '' "$head" "$later" "[\"$RO_TOKEN\"]")" HEAD
  check unknown-commit-indeterminate CH3_INDETERMINATE 3 "$(fixture ghost "$OK" '' 0000000000000000000000000000000000000000 "$later" "$T4")" HEAD
  check registration-file-absent-red CH3_RED 1 "$(fixture nofile "$OK" '' "$head" "$later" "$T4" audits/nope-preregistration-2099-01-01.md)" HEAD
  check registration-path-foreign-red CH3_RED 1 "$(fixture foreign "$OK" '' "$head" "$later" "$T4" README.md)" HEAD
  # a commit that exists but is not on the ref is NOT landed: HEAD measured against its own parent
  check not-landed-red CH3_RED 1 "$(fixture unlanded "$OK" '' "$head" "$later" "$T4")" HEAD~1
  # the missing-tool precondition, through the real entry point with a PATH that holds only bash
  ln -s "$(command -v bash)" "$tmp/bash"
  local out rc errtxt
  errtxt="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" "$tmp/good/a.md" 2>&1 >/dev/null)"
  out="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" "$tmp/good/a.md" 2>/dev/null)"; rc=$?
  cases=$((cases + 1))
  if [ "$out" = "CH3_INDETERMINATE" ] && [ "$rc" -eq 3 ] && printf '%s' "$errtxt" | grep -q "required tool 'node'"; then
    pass=$((pass + 1)); echo "SELF-TEST: ok missing-tool-indeterminate"
  else fail=$((fail + 1)); echo "SELF-TEST: FAIL missing-tool-indeterminate (got '$out' rc=$rc)"; fi
  rm -rf "$tmp"
  if [ "$cases" -lt 15 ]; then echo "ADS1_CH3_GATE_SELFTEST: FAIL vacuous ($cases cases)"; exit 1; fi
  if [ "$fail" -eq 0 ]; then echo "ADS1_CH3_GATE_SELFTEST: PASS ($pass checks)"; exit 0; fi
  echo "ADS1_CH3_GATE_SELFTEST: FAIL ($fail of $cases)"; exit 1
}

# sourceable: when sourced, define check_audit() and stop (no gate run)
if (return 0 2>/dev/null); then return 0; fi
if [ "${1:-}" = "--self-test" ]; then self_test; fi
run_gate "$@"
