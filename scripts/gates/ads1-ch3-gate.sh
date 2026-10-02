#!/usr/bin/env bash
# ads1-ch3-gate.sh — EDGE-ADS1-SCORECARD-W1 CH3 (registration, read-only extract, scorecard); amended by
# EDGE-ADS1-SCORECARD-W1-V3 CH3-A for the pre-read `-v2` amendment (registration §10).
#
# Reads the PRIVATE vault audit the scorecard wrote (its .md and the .json beside it) and the git history
# of this checkout. Nothing here reads a figure into the repo or prints one.
#
#   GREEN iff  the audit exists
#          ∧  its terminal line is `ADS1_SCORECARD_SELFCHECK: PASS (<k> checks)`
#          ∧  no `verdict: EXCEPTIONAL` and no `ADS1_PULL_WAIT` anywhere in it
#          ∧  the registration commit it names EXISTS here, is an ancestor of origin/main (it LANDED),
#             CONTAINS the registration file the audit names, and its committer timestamp — read from git,
#             not from the audit — precedes the recorded pull start
#          ∧  the AMENDMENT commit it names (§10) exists here, LANDED, INTRODUCES the amendment — its copy of the
#             registration carries exactly one `## <n>. Amendment` heading and its parent's copy carries none (so the
#             registration commit itself, or any other commit that merely touches the file, is refused) — and its
#             committer timestamp precedes the recorded pull start too (the later of the two commits decides)
#          ∧  every session part's token is `current_user=aoe_readonly transaction_read_only=on` (≥ 4 parts)
#          ∧  LRW's DONE probes are recorded YES (`LRW_RELABEL_COMPLETE=YES`, `LRW_ANNOTATION_COMPLETE=YES`)
#          ∧  the directional_labels write counters before = after
#          ∧  `gap_t10 = 0` on every `-v2` row (the coverage block: 0 non-zero, 0 NULL)
#
# Verdict — exactly one terminal line, the token is the contract:
#   CH3_GREEN          exit 0
#   CH3_RED            exit 1   any check failed
#   CH3_INDETERMINATE  exit 3   the audit (or its .json) is missing, a tool is missing, or git cannot
#                               resolve a named commit (cannot verify ≠ verified clean)
#
# A committed bash script on purpose (the tool shell is zsh: ${PIPESTATUS[0]} is empty and fails open).
# --self-test drives the REAL decision function (the script is sourceable) over synthetic audits against a
# SYNTHETIC git history built in a temp dir (registration, amendment, an unrelated commit, an unlanded commit —
# each with a pinned committer time), plus a PATH-stripped run for the missing tool.
#
# Usage:  scripts/gates/ads1-ch3-gate.sh <audit.md>          (the .json is <audit>.json beside it)
#         scripts/gates/ads1-ch3-gate.sh --self-test
set -uo pipefail

REQUIRED_TOOLS=(node git grep tail wc tr)
RO_TOKEN='TOKEN current_user=aoe_readonly transaction_read_only=on'

# introduces_amendment <commit> <path> → yes | no: the commit's copy of <path> carries exactly ONE `## <n>. Amendment`
# heading and its first parent's copy carries none. Implies the commit touches <path>.
introduces_amendment() {
  local here before
  here="$(git show "$1:$2" 2>/dev/null | grep -cE '^## [0-9]+\. Amendment ')"
  before="$(git show "$1^:$2" 2>/dev/null | grep -cE '^## [0-9]+\. Amendment ')"
  [ "${here:-0}" -eq 1 ] && [ "${before:-0}" -eq 0 ] && echo yes || echo no
}

# check_audit <audit.md> <remote-ref>  -> prints the token, returns its code
check_audit() {
  local md="$1" ref="$2" json="${1%.md}.json"
  if [ ! -r "$md" ] || [ ! -r "$json" ]; then
    printf '[ads1-ch3-gate] audit or its json missing: %s / %s\n' "$md" "$json" >&2
    echo CH3_INDETERMINATE; return 3
  fi
  local red="" last facts commit pull tokens_ok regpath amend done_ok counters_ok gap_ok ts ats
  last="$(grep -v '^[[:space:]]*$' "$md" | tail -n 1)"
  case "$last" in
    "ADS1_SCORECARD_SELFCHECK: PASS ("*" checks)") ;;
    *) red="$red selfcheck:'${last:0:80}'" ;;
  esac
  if grep -q 'verdict: EXCEPTIONAL' "$md"; then red="$red exceptional-verdict"; fi
  if grep -q 'ADS1_PULL_WAIT' "$md"; then red="$red pull-wait-in-audit"; fi
  facts="$(node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const g = j.generatedFrom || {};
    const ro = process.argv[2];
    const t = Array.isArray(g.tokenLines) ? g.tokenLines : [];
    const ok = t.length >= 4 && t.every((x) => x === ro);
    const d = Array.isArray(g.doneTokens) ? g.doneTokens.map(String) : [];
    const yes = (k) => d.some((x) => x.startsWith(k + "=YES"));
    const cb = g.countersBefore, ca = g.countersAfter;
    const cOk = !!cb && !!ca && ["ins", "upd", "del"].every((k) => Number.isFinite(cb[k]) && cb[k] === ca[k]);
    const cv = j.coverage || {};
    const gOk = cv.gapNonZero === 0 && cv.gapNull === 0;
    // "|"-joined with "-" for an empty field: `read` collapses runs of IFS WHITESPACE, so a space join would
    // shift every later field left when one is empty (and tab is IFS whitespace too)
    const f = (x) => (String(x || "").trim() === "" ? "-" : String(x).replace(/[|\s]/g, "_"));
    console.log([f(g.registrationCommit), Number(g.pullStartTs) || 0, ok ? "yes" : "no", f(g.registrationPath),
      f(g.amendmentCommit), yes("LRW_RELABEL_COMPLETE") && yes("LRW_ANNOTATION_COMPLETE") ? "yes" : "no",
      cOk ? "yes" : "no", gOk ? "yes" : "no"].join("|"));
  ' "$json" "$RO_TOKEN" 2>/dev/null)" || facts=""
  if [ -z "$facts" ]; then
    printf '[ads1-ch3-gate] the audit json is unreadable\n' >&2
    echo CH3_INDETERMINATE; return 3
  fi
  IFS='|' read -r commit pull tokens_ok regpath amend done_ok counters_ok gap_ok <<EOF
$facts
EOF
  [ "$commit" = - ] && commit=""; [ "$amend" = - ] && amend=""; [ "$regpath" = - ] && regpath=""
  [ "$tokens_ok" = "yes" ] || red="$red token"
  # occurrences, not lines: the audit prints the four tokens on one provenance line
  [ "$(grep -o "$RO_TOKEN" "$md" | wc -l | tr -d ' ')" -ge 4 ] || red="$red token-in-md"
  [ "$done_ok" = "yes" ] || red="$red lrw-done-token-missing"
  [ "$counters_ok" = "yes" ] || red="$red counter-delta"
  [ "$gap_ok" = "yes" ] || red="$red gap-t10-not-zero"
  if [ -z "$commit" ] || ! ts="$(git log -1 --format=%ct "$commit" 2>/dev/null)" || [ -z "$ts" ]; then
    printf '[ads1-ch3-gate] git cannot resolve the registration commit %s\n' "${commit:-<none>}" >&2
    [ -n "$red" ] && { printf '[ads1-ch3-gate] RED:%s\n' "$red" >&2; echo CH3_RED; return 1; }
    echo CH3_INDETERMINATE; return 3
  fi
  if [ -z "$amend" ] || ! ats="$(git log -1 --format=%ct "$amend" 2>/dev/null)" || [ -z "$ats" ]; then
    printf '[ads1-ch3-gate] git cannot resolve the amendment commit %s\n' "${amend:-<none>}" >&2
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
  # §10: the amendment is a commit that changes THIS registration — not any landed SHA — and it too precedes the pull
  git merge-base --is-ancestor "$amend" "$ref" 2>/dev/null || red="$red amendment-not-landed"
  [ "$(introduces_amendment "$amend" "$regpath")" = yes ] || red="$red amendment-does-not-introduce-the-amendment-heading"
  [ "$ats" -lt "$pull" ] || red="$red amendment-after-pull($ats>=$pull)"
  if [ -n "$red" ]; then printf '[ads1-ch3-gate] RED:%s\n' "$red" >&2; echo CH3_RED; return 1; fi
  printf '[ads1-ch3-gate] self-check PASS · no EXCEPTIONAL · registration %s @ %s and amendment %s @ %s landed < pull %s · RO tokens · LRW DONE · counters equal · gap 0\n' "$commit" "$ts" "$amend" "$ats" "$pull" >&2
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
  local pass=0 fail=0 cases=0 tmp repo here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/ads1-ch3-selftest.XXXXXX")" || { echo "ADS1_CH3_GATE_SELFTEST: FAIL mktemp"; exit 1; }
  trap 'rm -rf "$tmp"' EXIT
  # ── a synthetic history with pinned committer times, built so EVERY case trips exactly the check it names:
  #    main: T0 registration · T0+100 amendment (introduces `## 10. Amendment`) · T0+200 unrelated (other.txt; its tree
  #    still carries the registration) · T0+250 foreign (adds a nope-registration and README.md, each introducing an
  #    amendment heading)  ·  side (from the registration): T0+300 an amendment that never landed
  local REG='audits/ads1-scorecard-preregistration-2026-09-27.md' NOPE='audits/nope-preregistration-2099-01-01.md' T0=1790000000
  local H='## 10. Amendment 2026-10-02 — synthetic'
  repo="$tmp/repo"; mkdir -p "$repo/audits"
  gc() { GIT_AUTHOR_DATE="@$1 +0000" GIT_COMMITTER_DATE="@$1 +0000" git -C "$repo" -c user.name=t -c user.email=t@t commit -q -m "$2"; }
  git -C "$repo" init -q -b main || { echo "ADS1_CH3_GATE_SELFTEST: FAIL git init"; exit 1; }
  printf '## 9. x\nregistration\n' > "$repo/$REG"; git -C "$repo" add "$REG"; gc "$T0" registration
  printf '\n%s\namendment\n' "$H" >> "$repo/$REG"; git -C "$repo" add "$REG"; gc $((T0 + 100)) amendment
  printf 'x\n' > "$repo/other.txt"; git -C "$repo" add other.txt; gc $((T0 + 200)) unrelated
  printf '%s\n' "$H" > "$repo/$NOPE"; printf '%s\n' "$H" > "$repo/README.md"; git -C "$repo" add "$NOPE" README.md; gc $((T0 + 250)) foreign
  git -C "$repo" checkout -q -b side main~3; printf '\n%s\nlater\n' "$H" >> "$repo/$REG"; git -C "$repo" add "$REG"; gc $((T0 + 300)) unlanded
  git -C "$repo" checkout -q main
  local reg am other foreign side
  reg="$(git -C "$repo" rev-parse main~3)"; am="$(git -C "$repo" rev-parse main~2)"; other="$(git -C "$repo" rev-parse main~1)"
  foreign="$(git -C "$repo" rev-parse main)"; side="$(git -C "$repo" rev-parse side)"
  cd "$repo" || { echo "ADS1_CH3_GATE_SELFTEST: FAIL cd"; exit 1; }

  # fixture <name> <selfcheck line> <extra md line> <reg commit> <pull ts> <tokens json> [regpath] [amend] [done json] [counters-after json] [gap json]
  fixture() {
    local d="$tmp/$1"; mkdir -p "$d"
    printf '# audit\n\n- Read-only tokens: `%s` · `%s` · `%s` · `%s`\n%s\n\n%s\n' "$RO_TOKEN" "$RO_TOKEN" "$RO_TOKEN" "$RO_TOKEN" "$3" "$2" > "$d/a.md"
    printf '{"generatedFrom":{"registrationCommit":"%s","pullStartTs":%s,"tokenLines":%s,"registrationPath":"%s","amendmentCommit":"%s","doneTokens":%s,"countersBefore":{"ins":5,"upd":7,"del":0},"countersAfter":%s},"coverage":%s}\n' \
      "$4" "$5" "$6" "${7:-$REG}" "${8:-$am}" "${9:-$DONE}" "${10:-$CNT}" "${11:-$GAP}" > "$d/a.json"
    echo "$d/a.md"
  }
  check() { # <name> <want token> <want rc> <md> <ref>
    local out rc
    out="$(check_audit "$4" "$5" 2>/dev/null)"; rc=$?
    cases=$((cases + 1))
    if [ "$out" = "$2" ] && [ "$rc" -eq "$3" ]; then pass=$((pass + 1)); echo "SELF-TEST: ok $1"
    else fail=$((fail + 1)); echo "SELF-TEST: FAIL $1 (got '$out' rc=$rc, want '$2' rc=$3)"; fi
  }
  local OK='ADS1_SCORECARD_SELFCHECK: PASS (21 checks)' T4="[\"$RO_TOKEN\",\"$RO_TOKEN\",\"$RO_TOKEN\",\"$RO_TOKEN\"]"
  local DONE='["LRW_RELABEL_COMPLETE=YES {}","LRW_ANNOTATION_COMPLETE=YES {}"]' CNT='{"ins":5,"upd":7,"del":0}' GAP='{"gapNonZero":0,"gapNull":0}'
  local later=$((T0 + 260)) between=$((T0 + 50))
  # ── V2's cases, re-based on the synthetic history
  check all-good-green CH3_GREEN 0 "$(fixture good "$OK" '- verdict: NO_CLAIM' "$reg" "$later" "$T4")" main
  check audit-missing-indeterminate CH3_INDETERMINATE 3 "$tmp/nowhere/a.md" main
  check json-missing-indeterminate CH3_INDETERMINATE 3 "$(d="$tmp/nojson"; mkdir -p "$d"; printf '%s\n' "$OK" > "$d/a.md"; echo "$d/a.md")" main
  check selfcheck-fail-red CH3_RED 1 "$(fixture sfail 'ADS1_SCORECARD_SELFCHECK: FAIL pooled identity' '' "$reg" "$later" "$T4")" main
  check selfcheck-not-terminal-red CH3_RED 1 "$(fixture notlast "$OK" '' "$reg" "$later" "$T4"; printf 'trailing prose\n' >> "$tmp/notlast/a.md")" main
  check exceptional-red CH3_RED 1 "$(fixture exc "$OK" '- verdict: EXCEPTIONAL' "$reg" "$later" "$T4")" main
  # the registration is a LATER commit that contains the file; the amendment (T0+100) stays before the pull
  check registration-after-pull-red CH3_RED 1 "$(fixture late "$OK" '' "$other" "$((T0 + 150))" "$T4")" main
  check registration-same-second-red CH3_RED 1 "$(fixture same "$OK" '' "$other" "$((T0 + 200))" "$T4")" main
  check writer-token-red CH3_RED 1 "$(fixture writer "$OK" '' "$reg" "$later" "[\"$RO_TOKEN\",\"TOKEN current_user=algovault_app transaction_read_only=off\",\"$RO_TOKEN\",\"$RO_TOKEN\"]")" main
  check too-few-tokens-red CH3_RED 1 "$(fixture few "$OK" '' "$reg" "$later" "[\"$RO_TOKEN\"]")" main
  check unknown-commit-indeterminate CH3_INDETERMINATE 3 "$(fixture ghost "$OK" '' 0000000000000000000000000000000000000000 "$later" "$T4")" main
  # the amendment introduces a heading in the NAMED path, so only the registration-side check can fire
  check registration-file-absent-red CH3_RED 1 "$(fixture nofile "$OK" '' "$reg" "$later" "$T4" "$NOPE" "$foreign")" main
  check registration-path-foreign-red CH3_RED 1 "$(fixture forpath "$OK" '' "$reg" "$later" "$T4" README.md "$foreign")" main
  check not-landed-red CH3_RED 1 "$(fixture unlanded "$OK" '' "$side" "$((T0 + 400))" "$T4")" main
  # ── the four new mutations (registration §10), each RED, each isolating one check
  check amendment-after-pull-red CH3_RED 1 "$(fixture amlate "$OK" '' "$reg" "$between" "$T4")" main
  check done-token-missing-red CH3_RED 1 "$(fixture nodone "$OK" '' "$reg" "$later" "$T4" "$REG" "$am" '["LRW_RELABEL_COMPLETE=YES {}"]')" main
  check counter-delta-red CH3_RED 1 "$(fixture delta "$OK" '' "$reg" "$later" "$T4" "$REG" "$am" "$DONE" '{"ins":6,"upd":7,"del":0}')" main
  check nonzero-gap-red CH3_RED 1 "$(fixture gap "$OK" '' "$reg" "$later" "$T4" "$REG" "$am" "$DONE" "$CNT" '{"gapNonZero":1,"gapNull":0}')" main
  # ── and the rest of the §10 surface
  check amendment-not-touching-registration-red CH3_RED 1 "$(fixture amother "$OK" '' "$reg" "$later" "$T4" "$REG" "$other")" main
  # the HIGH-severity case: the registration commit itself touches the file — it is not the amendment
  check amendment-is-the-registration-commit-red CH3_RED 1 "$(fixture amreg "$OK" '' "$reg" "$later" "$T4" "$REG" "$reg")" main
  check amendment-same-second-red CH3_RED 1 "$(fixture amsame "$OK" '' "$reg" "$((T0 + 100))" "$T4")" main
  check empty-amendment-field-indeterminate CH3_INDETERMINATE 3 "$(fixture amempty "$OK" '' "$reg" "$later" "$T4" "$REG" '-')" main
  check empty-registration-field-indeterminate CH3_INDETERMINATE 3 "$(fixture regempty "$OK" '' '' "$later" "$T4")" main
  check amendment-not-landed-red CH3_RED 1 "$(fixture amside "$OK" '' "$reg" "$((T0 + 400))" "$T4" "$REG" "$side")" main
  check amendment-unknown-indeterminate CH3_INDETERMINATE 3 "$(fixture amghost "$OK" '' "$reg" "$later" "$T4" "$REG" 0000000000000000000000000000000000000001)" main
  check null-gap-red CH3_RED 1 "$(fixture gapnull "$OK" '' "$reg" "$later" "$T4" "$REG" "$am" "$DONE" "$CNT" '{"gapNonZero":0,"gapNull":3}')" main
  check pull-wait-in-audit-red CH3_RED 1 "$(fixture waited "$OK" 'ADS1_PULL_WAIT: lrw-relabel-not-done' "$reg" "$later" "$T4")" main
  # the missing-tool precondition, through the real entry point with a PATH that holds only bash
  ln -s "$(command -v bash)" "$tmp/bash"
  local out rc errtxt
  errtxt="$(env PATH="$tmp" "$tmp/bash" "$here" "$tmp/good/a.md" 2>&1 >/dev/null)"
  out="$(env PATH="$tmp" "$tmp/bash" "$here" "$tmp/good/a.md" 2>/dev/null)"; rc=$?
  cases=$((cases + 1))
  if [ "$out" = "CH3_INDETERMINATE" ] && [ "$rc" -eq 3 ] && grep -q "required tool 'node'" <<<"$errtxt"; then
    pass=$((pass + 1)); echo "SELF-TEST: ok missing-tool-indeterminate"
  else fail=$((fail + 1)); echo "SELF-TEST: FAIL missing-tool-indeterminate (got '$out' rc=$rc)"; fi
  if [ "$cases" -lt 28 ]; then echo "ADS1_CH3_GATE_SELFTEST: FAIL vacuous ($cases cases)"; exit 1; fi
  if [ "$fail" -eq 0 ]; then echo "ADS1_CH3_GATE_SELFTEST: PASS ($pass checks)"; exit 0; fi
  echo "ADS1_CH3_GATE_SELFTEST: FAIL ($fail of $cases)"; exit 1
}

# sourceable: when sourced, define check_audit() and stop (no gate run)
if (return 0 2>/dev/null); then return 0; fi
if [ "${1:-}" = "--self-test" ]; then self_test; fi
run_gate "$@"
