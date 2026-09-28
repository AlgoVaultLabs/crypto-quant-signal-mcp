#!/usr/bin/env bash
# lrw-ch1-gate.sh — EDGE-LABELER-RACE-WINDOW-V2-W1 CH1 (R0 probes + the landed registration).
#
# GREEN iff
#   (a) the wave's endpoint-truth carries exactly one line per probe, PROBE_<n>=<VALUE> for n = 1..8:
#         CONFIRMED                 the probe re-observed the spec (a cite-only drift fixed inline stays
#                                   CONFIRMED and carries a correction row — ruling LRW-Q14-a)
#         MEASURED                  probes 3, 4, 5, 6 only (census, sizing, replay, DDL facts)
#         SHARED | HOLD_LABELER_UNAFFECTED   probe 2 only (does the hold labeler share the defect?)
#         DRIFT                     substantive drift                         -> CH1_RED
#         UNMEASURED / anything else                                          -> CH1_INDETERMINATE
#   (b) the registration LANDED: a commit on <ref> added it, contains it, and is an ancestor of <ref>
#       (PROCEDURE §1 binds on landing, not on committing);
#   (c) the vault mirror carries it: the mirror's generated verifier prints PREREG_MIRROR_VERDICT=PASS
#       AND its manifest row for the registration names the blob that landed on <ref>.
#
# Verdict — exactly one terminal line; the token is the contract, never the exit code alone:
#   CH1_GREEN          exit 0
#   CH1_RED            exit 1   any DRIFT, registration absent from <ref>, mirror FAIL / missing / stale blob
#   CH1_INDETERMINATE  exit 3   a probe line missing, conflicting or unparseable; a file unreadable; a
#                               required tool absent; git cannot read <ref>; the mirror verifier missing
#                               or INDETERMINATE (cannot verify ≠ verified clean)
# RED outranks INDETERMINATE: a definitive failure is reported even when another leg is unreadable.
#
# A committed bash script on purpose: the Claude Code tool shell is zsh, where ${PIPESTATUS[0]} is empty
# and `[ "" -eq 0 ]` is TRUE — a gate pasted there fails OPEN. bash 3.2 compatible (no mapfile).
#
# Usage:
#   scripts/gates/lrw-ch1-gate.sh [--endpoint-truth <md>] [--registration <audits/…md>] [--ref <ref>]
#                                 [--mirror-dir <dir>]
#   scripts/gates/lrw-ch1-gate.sh --self-test
set -uo pipefail

REQUIRED_TOOLS=(git grep sed sort tail basename)
DEFAULT_TRUTH='audits/EDGE-LABELER-RACE-WINDOW-V2-W1-endpoint-truth.md'
DEFAULT_REG='audits/labeler-race-window-v2-preregistration-2026-09-28.md'
DEFAULT_REF='origin/main'

log() { printf '[lrw-ch1-gate] %s\n' "$*" >&2; }

# probe_legs <endpoint-truth>  -> prints "RED <reasons>" | "IND <reasons>" | "OK"
probe_legs() {
  local path="$1" drift=0 ind=0 reasons="" n lines values count value
  if [ ! -r "$path" ]; then echo "IND endpoint-truth-unreadable:$path"; return; fi
  for n in 1 2 3 4 5 6 7 8; do
    lines="$(grep -E "^PROBE_${n}=" "$path" || true)"
    if [ -z "$lines" ]; then ind=1; reasons="$reasons PROBE_${n}:missing"; continue; fi
    values="$(printf '%s\n' "$lines" | sed -E "s/^PROBE_${n}=([A-Z_]+).*/\1/" | sort -u)"
    count="$(printf '%s\n' "$values" | grep -c .)"
    if [ "$count" -ne 1 ]; then ind=1; reasons="$reasons PROBE_${n}:conflicting"; continue; fi
    value="$values"
    case "$value" in
      CONFIRMED) ;;
      MEASURED)
        case "$n" in 3|4|5|6) ;; *) ind=1; reasons="$reasons PROBE_${n}:MEASURED-not-valid-here" ;; esac ;;
      SHARED|HOLD_LABELER_UNAFFECTED)
        [ "$n" -eq 2 ] || { ind=1; reasons="$reasons PROBE_${n}:${value}-only-valid-for-probe-2"; } ;;
      DRIFT) drift=1; reasons="$reasons PROBE_${n}:DRIFT" ;;
      *) ind=1; reasons="$reasons PROBE_${n}:unparseable(${value})" ;;
    esac
  done
  if [ "$drift" -eq 1 ]; then echo "RED$reasons"; elif [ "$ind" -eq 1 ]; then echo "IND$reasons"; else echo "OK"; fi
}

# registration_leg <repo-dir> <ref> <reg-path>  -> "RED …" | "IND …" | "OK <commit> <blob>"
registration_leg() {
  local dir="$1" ref="$2" reg="$3" commit blob
  if ! git -C "$dir" rev-parse --verify --quiet "$ref^{commit}" >/dev/null 2>&1; then
    echo "IND ref-unreadable:$ref"; return
  fi
  commit="$(git -C "$dir" log -1 --diff-filter=A --format=%H "$ref" -- "$reg" 2>/dev/null || true)"
  if [ -z "$commit" ]; then echo "RED registration-not-landed-on:$ref"; return; fi
  git -C "$dir" cat-file -e "$commit:$reg" 2>/dev/null || { echo "RED registration-not-in-commit:$commit"; return; }
  # No separate `merge-base --is-ancestor`: `git log <ref>` only walks commits reachable from <ref>, so the
  # adding commit is an ancestor BY CONSTRUCTION. (A mutation deleting such a check survived the self-test —
  # it could never fire — which is how the redundancy was found; a check that cannot fail is not kept.)
  blob="$(git -C "$dir" rev-parse "$ref:$reg" 2>/dev/null || true)"
  [ -n "$blob" ] || { echo "RED registration-absent-at-tip:$ref"; return; }
  echo "OK $commit $blob"
}

# mirror_leg <mirror-dir> <reg-basename> <landed-blob>  -> "RED …" | "IND …" | "OK"
mirror_leg() {
  local mdir="$1" base="$2" blob="$3" out tok row
  [ -r "$mdir/_verify.sh" ] || { echo "IND mirror-verifier-missing:$mdir"; return; }
  out="$(bash "$mdir/_verify.sh" 2>/dev/null)"
  tok="$(printf '%s\n' "$out" | grep -E '^PREREG_MIRROR_VERDICT=' | tail -n 1 | sed 's/^PREREG_MIRROR_VERDICT=//')"
  case "$tok" in
    PASS) ;;
    FAIL) echo "RED mirror-verdict:FAIL"; return ;;
    *) echo "IND mirror-verdict:${tok:-none}"; return ;;
  esac
  row="$(grep -F "${base}|registration|" "$mdir/_verify.sh" | grep -v '^[[:space:]]*#' | tail -n 1 || true)"
  [ -n "$row" ] || { echo "RED registration-not-mirrored:$base"; return; }
  case "$row" in
    "${base}|registration|${blob}|"*) echo "OK" ;;
    *) echo "RED mirror-carries-another-blob:$base" ;;
  esac
}

# evaluate <repo-dir> <truth> <reg> <ref> <mirror-dir>  -> prints the token, returns its code
evaluate() {
  local dir="$1" truth="$2" reg="$3" ref="$4" mdir="$5" t red="" ind="" p r m rest commit blob
  for t in "${REQUIRED_TOOLS[@]}"; do
    command -v "$t" >/dev/null 2>&1 || { log "required tool '$t' not on PATH"; echo CH1_INDETERMINATE; return 3; }
  done
  p="$(probe_legs "$truth")"
  case "$p" in RED*) red="$red ${p#RED}" ;; IND*) ind="$ind ${p#IND}" ;; esac
  r="$(registration_leg "$dir" "$ref" "$reg")"
  case "$r" in
    RED*) red="$red ${r#RED}" ;;
    IND*) ind="$ind ${r#IND}" ;;
    OK*) rest="${r#OK }"; commit="${rest%% *}"; blob="${rest#* }"
         m="$(mirror_leg "$mdir" "$(basename "$reg")" "$blob")"
         case "$m" in RED*) red="$red ${m#RED}" ;; IND*) ind="$ind ${m#IND}" ;; esac ;;
  esac
  if [ -n "$red" ]; then log "RED:$red${ind:+ | also unverifiable:$ind}"; echo CH1_RED; return 1; fi
  if [ -n "$ind" ]; then log "cannot verify:$ind"; echo CH1_INDETERMINATE; return 3; fi
  log "8 probe lines clean · registration landed in $commit (blob $blob) · mirror PASS with that blob"
  echo CH1_GREEN; return 0
}

default_mirror_dir() { # the vault root comes from the ONE declaration, never a second literal
  local root lib="$1/scripts/lib/system-map-path.sh"
  [ -r "$lib" ] || return 1
  # shellcheck source=/dev/null
  root="$(. "$lib" && dirname "$ALGOVAULT_SYSTEM_MAP_PATH")" || return 1
  printf '%s/Claude files/repo-preregistrations' "$root"
}

self_test() {
  local tmp gate pass=0 fail=0 cases=0 repo blob out rc tok
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/lrw-ch1-selftest.XXXXXX")" || { echo "LRW_CH1_GATE_SELFTEST: FAIL mktemp"; exit 1; }
  trap 'rm -rf "$tmp"' EXIT
  gate="${BASH_SOURCE[0]}"
  # hermetic git: never the caller's hooks, identity or index
  unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_COMMON_DIR GIT_QUARANTINE_PATH
  repo="$tmp/repo"; mkdir -p "$repo/audits"
  git -C "$repo" init -q
  git -C "$repo" config user.email selftest@invalid; git -C "$repo" config user.name selftest
  git -C "$repo" config core.hooksPath /dev/null
  printf 'registration body\n' > "$repo/audits/x-preregistration-2026-01-01.md"
  git -C "$repo" add audits/x-preregistration-2026-01-01.md
  git -C "$repo" commit -q -m reg
  git -C "$repo" update-ref refs/remotes/origin/main HEAD
  blob="$(git -C "$repo" rev-parse origin/main:audits/x-preregistration-2026-01-01.md)"
  printf 'other\n' > "$repo/audits/y-preregistration-2026-01-02.md"   # never committed

  mkmirror() { # <dir> <verdict> <row-blob|NONE>
    mkdir -p "$1"
    { printf '#!/usr/bin/env bash\n'
      [ "$3" = NONE ] || printf "FILES='\nx-preregistration-2026-01-01.md|registration|%s|900\n'\n" "$3"
      printf 'echo "PREREG_MIRROR_VERDICT=%s"\n' "$2"; } > "$1/_verify.sh"
  }
  mkmirror "$tmp/m-pass" PASS "$blob"
  mkmirror "$tmp/m-fail" FAIL "$blob"
  mkmirror "$tmp/m-ind" INDETERMINATE "$blob"
  mkmirror "$tmp/m-norow" PASS NONE
  mkmirror "$tmp/m-oldblob" PASS 0000000000000000000000000000000000000000
  mkdir -p "$tmp/m-empty"

  write_truth() { # <file> [override lines...]
    local f="$1"; shift; : > "$f"
    printf 'PROBE_1=CONFIRMED cite fixed inline\nPROBE_2=SHARED\nPROBE_3=MEASURED\nPROBE_4=MEASURED\n' >> "$f"
    printf 'PROBE_5=MEASURED\nPROBE_6=MEASURED\nPROBE_7=CONFIRMED\nPROBE_8=CONFIRMED\n' >> "$f"
    local l; for l in "$@"; do printf '%s\n' "$l" >> "$f"; done
  }
  run() { # <truth> <reg> <mirror> [PATH-override-bin]
    if [ -n "${4:-}" ]; then env PATH="$4" "$4/bash" "$gate" --repo "$repo" --endpoint-truth "$1" --registration "$2" --ref origin/main --mirror-dir "$3"
    else bash "$gate" --repo "$repo" --endpoint-truth "$1" --registration "$2" --ref origin/main --mirror-dir "$3"; fi
  }
  check() { # <name> <want token> <want rc> <cmd...>
    local name="$1" wt="$2" wr="$3"; shift 3
    out="$("$@" 2>/dev/null)"; rc=$?; tok="$(printf '%s\n' "$out" | tail -n 1)"
    cases=$((cases + 1))
    if [ "$tok" = "$wt" ] && [ "$rc" -eq "$wr" ]; then pass=$((pass + 1)); echo "SELF-TEST: ok $name"
    else fail=$((fail + 1)); echo "SELF-TEST: FAIL $name (got '$tok' rc=$rc, want '$wt' rc=$wr)"; fi
  }
  checkr() { # <name> <want token> <want rc> <want reason substring> <cmd...> — the RIGHT leg must say so
    local name="$1" wt="$2" wr="$3" why="$4" err; shift 4
    err="$("$@" 2>&1 >/dev/null)"; out="$("$@" 2>/dev/null)"; rc=$?; tok="$(printf '%s\n' "$out" | tail -n 1)"
    cases=$((cases + 1))
    if [ "$tok" = "$wt" ] && [ "$rc" -eq "$wr" ] && printf '%s' "$err" | grep -qF "$why"; then
      pass=$((pass + 1)); echo "SELF-TEST: ok $name"
    else fail=$((fail + 1)); echo "SELF-TEST: FAIL $name (got '$tok' rc=$rc, want '$wt' rc=$wr + reason '$why')"; fi
  }
  local R=audits/x-preregistration-2026-01-01.md
  write_truth "$tmp/green.md"
  check green CH1_GREEN 0 run "$tmp/green.md" "$R" "$tmp/m-pass"
  write_truth "$tmp/unaffected.md" "PROBE_2=HOLD_LABELER_UNAFFECTED"; sed -i.bak '/^PROBE_2=SHARED/d' "$tmp/unaffected.md"
  check probe2-unaffected-green CH1_GREEN 0 run "$tmp/unaffected.md" "$R" "$tmp/m-pass"
  write_truth "$tmp/drift.md" "PROBE_7=DRIFT substantive"; sed -i.bak '/^PROBE_7=CONFIRMED/d' "$tmp/drift.md"
  checkr synthetic-drift-red CH1_RED 1 PROBE_7:DRIFT run "$tmp/drift.md" "$R" "$tmp/m-pass"
  write_truth "$tmp/missing.md"; sed -i.bak '/^PROBE_4=/d' "$tmp/missing.md"
  check missing-probe-indeterminate CH1_INDETERMINATE 3 run "$tmp/missing.md" "$R" "$tmp/m-pass"
  write_truth "$tmp/conflict.md" "PROBE_3=CONFIRMED"
  check conflicting-probe-indeterminate CH1_INDETERMINATE 3 run "$tmp/conflict.md" "$R" "$tmp/m-pass"
  write_truth "$tmp/shared-wrong.md" "PROBE_5=SHARED"; sed -i.bak '/^PROBE_5=MEASURED/d' "$tmp/shared-wrong.md"
  check shared-outside-probe2-indeterminate CH1_INDETERMINATE 3 run "$tmp/shared-wrong.md" "$R" "$tmp/m-pass"
  write_truth "$tmp/measured-wrong.md" "PROBE_1=MEASURED"; sed -i.bak '/^PROBE_1=CONFIRMED/d' "$tmp/measured-wrong.md"
  check measured-outside-3to6-indeterminate CH1_INDETERMINATE 3 run "$tmp/measured-wrong.md" "$R" "$tmp/m-pass"
  write_truth "$tmp/garbage.md" "PROBE_8=MAYBE"; sed -i.bak '/^PROBE_8=CONFIRMED/d' "$tmp/garbage.md"
  check unparseable-indeterminate CH1_INDETERMINATE 3 run "$tmp/garbage.md" "$R" "$tmp/m-pass"
  check missing-truth-indeterminate CH1_INDETERMINATE 3 run "$tmp/nope.md" "$R" "$tmp/m-pass"
  checkr registration-not-landed-red CH1_RED 1 registration-not-landed run "$tmp/green.md" audits/y-preregistration-2026-01-02.md "$tmp/m-pass"
  checkr mirror-fail-red CH1_RED 1 mirror-verdict:FAIL run "$tmp/green.md" "$R" "$tmp/m-fail"
  check mirror-indeterminate CH1_INDETERMINATE 3 run "$tmp/green.md" "$R" "$tmp/m-ind"
  checkr mirror-without-row-red CH1_RED 1 registration-not-mirrored run "$tmp/green.md" "$R" "$tmp/m-norow"
  checkr mirror-stale-blob-red CH1_RED 1 mirror-carries-another-blob run "$tmp/green.md" "$R" "$tmp/m-oldblob"
  check mirror-verifier-missing-indeterminate CH1_INDETERMINATE 3 run "$tmp/green.md" "$R" "$tmp/m-empty"
  check red-outranks-indeterminate CH1_RED 1 run "$tmp/missing.md" "$R" "$tmp/m-fail"
  # a required tool absent: PATH holding only bash
  mkdir -p "$tmp/bin" && ln -s "$(command -v bash)" "$tmp/bin/bash"
  check missing-tool-indeterminate CH1_INDETERMINATE 3 run "$tmp/green.md" "$R" "$tmp/m-pass" "$tmp/bin"
  cases=$((cases + 1))
  # capture first: under pipefail a piped `grep -q` would inherit the gate's own exit 3
  local errtxt
  errtxt="$(env PATH="$tmp/bin" "$tmp/bin/bash" "$gate" --repo "$repo" --endpoint-truth "$tmp/green.md" \
    --registration "$R" --mirror-dir "$tmp/m-pass" 2>&1 >/dev/null)"
  if printf '%s' "$errtxt" | grep -q "required tool 'git'"; then
    pass=$((pass + 1)); echo "SELF-TEST: ok missing-tool-named"
  else fail=$((fail + 1)); echo "SELF-TEST: FAIL missing-tool-named"; fi
  # vacuity guard: the corpus is constructed here, so too few cases is a defect of this test
  if [ "$cases" -lt 18 ]; then echo "LRW_CH1_GATE_SELFTEST: FAIL vacuous ($cases cases)"; exit 1; fi
  if [ "$fail" -eq 0 ]; then echo "LRW_CH1_GATE_SELFTEST: PASS ($pass checks)"; exit 0; fi
  echo "LRW_CH1_GATE_SELFTEST: FAIL ($fail of $cases)"; exit 1
}

main() {
  local repo="" truth="" reg="" ref="" mdir=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --self-test) self_test ;;
      --repo) repo="$2"; shift 2 ;;
      --endpoint-truth) truth="$2"; shift 2 ;;
      --registration) reg="$2"; shift 2 ;;
      --ref) ref="$2"; shift 2 ;;
      --mirror-dir) mdir="$2"; shift 2 ;;
      *) log "unknown argument: $1"; echo CH1_INDETERMINATE; exit 3 ;;
    esac
  done
  if [ -z "$repo" ]; then
    repo="$(git rev-parse --show-toplevel 2>/dev/null)" || { log "not inside a git checkout"; echo CH1_INDETERMINATE; exit 3; }
  fi
  [ -n "$truth" ] || truth="$repo/$DEFAULT_TRUTH"
  [ -n "$reg" ] || reg="$DEFAULT_REG"
  [ -n "$ref" ] || ref="$DEFAULT_REF"
  if [ -z "$mdir" ]; then
    mdir="$(default_mirror_dir "$repo")" || { log "cannot resolve the vault mirror directory"; echo CH1_INDETERMINATE; exit 3; }
  fi
  evaluate "$repo" "$truth" "$reg" "$ref" "$mdir"
  exit $?
}

# sourceable: a sourcing test gets the functions without running the gate
if (return 0 2>/dev/null); then return 0; fi
main "$@"
