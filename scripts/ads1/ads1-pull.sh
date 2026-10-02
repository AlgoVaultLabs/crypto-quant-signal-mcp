#!/usr/bin/env bash
# ads1-pull.sh — EDGE-ADS1-SCORECARD-W1-V3 CH3-B R11 + R12: the ADS-1 scorecard's REGISTERED read session
# (registration §3.1 + §10.3). Committed in Dispatch A so Dispatch B changes no code (Build Rule 2).
#
# Runs, from a repo checkout on the Mac, after `npm run build`:
#   R11  run conditions, printed first; ANY false → `ADS1_PULL_WAIT: <condition>`, exit 3, and NO registered
#        statement is executed (the only DB reads before them are LRW's own label-free DONE probes):
#          · `date -u` inside 06:30–17:45Z (outside the relabel nights 18:30–02:15Z and the nightly 02:20–06:30Z)
#          · no labeller / relabel runner / annotation alive on signal-1 (LRW's self-match-proof WRITER_PATTERN)
#          · LRW's runner summary all CONVERGED (LRW's own `summary_state`) AND its read-only DONE probes YES —
#            the relabel (MISSING_V2 vs the manifest) and the annotation (NULL_V1_GAP vs the pinned worklists),
#            measured on the rows by `dist/scripts/lrw/completeness.js`, never taken from a status line
#          · no Deploy run in flight (`gh run list --workflow deploy.yml`) — a recreate mid-session would void the
#            counter assertion
#          · the vault mirror's `_verify.sh` prints PREREG_MIRROR_VERDICT=PASS
#          · the registration commit AND the amendment are ancestors of origin/main, the amendment INTRODUCES the
#            amendment (its copy of the registration carries exactly one `## <n>. Amendment` heading, its parent's
#            none — so the registration commit, or any commit that merely touches the file, is refused), and both
#            were committed before this pull
#          · the relabel launch epoch (LRW's CH3 entry) is a number ≥ T_CUT and in the past
#   R12  four parts, each its own `BEGIN READ ONLY` as `aoe_readonly`, the token first, every statement printed by
#        `node dist/scripts/ads1-scorecard.js --print-session <part>` (the generator the registration is pinned to):
#          counters-before → extract → label-free (census, side mix, integrity, presence) → counters-after
#        the tier instrument fetched ONCE (§3.2); every output to --out (Mac scratch — never committed, never the vault)
#   assert every token line is the read-only token; the write counters did not move; the extract carries a data row
#
# Verdict — exactly one terminal line, the token is the contract:
#   ADS1_PULL_WAIT: <condition>          exit 3   an R11 condition is false — nothing registered was read
#   ADS1_PULL_VERDICT=PASS               exit 0   the session ran; outputs + pull-meta.json in --out
#   ADS1_PULL_VERDICT=FAIL               exit 1   a token was not read-only, the counters moved, or a part failed
#   ADS1_PULL_VERDICT=INDETERMINATE      exit 3   a tool / the build / the host / an output could not be read
# A committed bash script on purpose (the agent tool shell is zsh). --self-test drives the real decide() and wait_line().
#
# Usage: scripts/ads1/ads1-pull.sh --amendment <sha> --relabel-launch <epoch> --manifest <log>[,<log>…]
#          --worklists <gz>,<gz> --runner-summary <file> --out <dir>
#        scripts/ads1/ads1-pull.sh --self-test
set -uo pipefail

REG_COMMIT='6d43486c'
REG_FILE='audits/ads1-scorecard-preregistration-2026-09-27.md'
RO_TOKEN='TOKEN current_user=aoe_readonly transaction_read_only=on'
HOST='root@204.168.185.24'
KEY="$HOME/.ssh/algovault_deploy"
PG_CTR='crypto-quant-signal-mcp-postgres-1'
TIERS_URL='https://api.algovault.com/api/performance-public'
LRW_PULL='scripts/lrw/lrw-pull.sh'
REQUIRED_TOOLS=(ssh node git gh curl shasum date grep sed awk wc)
WINDOW_MIN=$((6 * 60 + 30)) # 06:30Z
WINDOW_MAX=$((17 * 60 + 45)) # 17:45Z

log() { printf '[ads1-pull] %s\n' "$*" >&2; }

# introduces_amendment <commit> → yes | no: <commit>'s copy of the registration carries exactly ONE `## <n>. Amendment`
# heading and its first parent's copy none (implies the commit touches the registration)
introduces_amendment() {
  local here before
  here="$(git show "$1:$REG_FILE" 2>/dev/null | grep -cE '^## [0-9]+\. Amendment ')"
  before="$(git show "$1^:$REG_FILE" 2>/dev/null | grep -cE '^## [0-9]+\. Amendment ')"
  [ "${here:-0}" -eq 1 ] && [ "${before:-0}" -eq 0 ] && echo yes || echo no
}

# wait_line <condition> — the R11 refusal: one line, exit code 3 (a WAIT is "not yet", never a failure)
wait_line() { echo "ADS1_PULL_WAIT: $1"; return 3; }

# in_window <minutes since 00:00Z> → 0 iff inside [06:30, 17:45)
in_window() { [ "$1" -ge "$WINDOW_MIN" ] && [ "$1" -lt "$WINDOW_MAX" ]; }

# decide <tokens> <counters> <files> → the verdict line, returns its code.  tokens: ok|fail|ind  counters: equal|moved|ind  files: ok|ind
decide() {
  local tokens="$1" counters="$2" files="$3" red="" ind=""
  case "$tokens" in ok) ;; fail) red="$red token-not-read-only" ;; *) ind="$ind tokens" ;; esac
  case "$counters" in equal) ;; moved) red="$red concurrent-writer" ;; *) ind="$ind counters" ;; esac
  case "$files" in ok) ;; *) ind="$ind outputs" ;; esac
  if [ -n "$red" ]; then log "FAIL:$red"; echo 'ADS1_PULL_VERDICT=FAIL'; return 1; fi
  if [ -n "$ind" ]; then log "cannot verify:$ind"; echo 'ADS1_PULL_VERDICT=INDETERMINATE'; return 3; fi
  echo 'ADS1_PULL_VERDICT=PASS'; return 0
}

# LRW's writer pattern and runner-summary reader — imported from the LRW pull (sourced in a subshell), never retyped
lrw_writer_pattern() { (. "$LRW_PULL" && printf '%s' "$WRITER_PATTERN"); }
lrw_summary_state() { bash "$LRW_PULL" --summary-state "$1"; }

# ro_session <part> <out-file> — one part of the session, exactly as the generator prints it
ro_session() {
  node dist/scripts/ads1-scorecard.js --print-session "$1" |
    ssh -o ConnectTimeout=20 -o ServerAliveInterval=15 -i "$KEY" "$HOST" \
      "docker exec -i $PG_CTR psql -U aoe_readonly -d signal_performance -At -q" > "$2"
}

# ro_probe <out-file> <sql> — one label-free LRW DONE probe statement in its own READ ONLY transaction, token first
ro_probe() {
  { printf 'BEGIN READ ONLY;\n%s;\n%s;\nROLLBACK;\n' "$(node dist/scripts/lrw/extract-sql.js --emit TOKEN)" "$2"; } |
    ssh -o ConnectTimeout=20 -o ServerAliveInterval=15 -i "$KEY" "$HOST" \
      "docker exec -i $PG_CTR psql -U aoe_readonly -d signal_performance -At -q -v ON_ERROR_STOP=1" > "$1"
}

run_pull() {
  local amend="" launch="" manifest="" worklists="" summary="" out=""
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || { log "$1 needs a value"; echo 'ADS1_PULL_VERDICT=INDETERMINATE'; exit 3; }
    case "$1" in
      --amendment) amend="$2" ;;
      --relabel-launch) launch="$2" ;;
      --manifest) manifest="$2" ;;
      --worklists) worklists="$2" ;;
      --runner-summary) summary="$2" ;;
      --out) out="$2" ;;
      *) log "unknown argument $1"; echo 'ADS1_PULL_VERDICT=INDETERMINATE'; exit 3 ;;
    esac
    shift 2
  done
  local t
  for t in "${REQUIRED_TOOLS[@]}"; do
    command -v "$t" >/dev/null 2>&1 || { log "required tool '$t' not on PATH"; echo 'ADS1_PULL_VERDICT=INDETERMINATE'; exit 3; }
  done
  [ -n "$amend" ] && [ -n "$launch" ] && [ -n "$manifest" ] && [ -n "$worklists" ] && [ -n "$summary" ] && [ -n "$out" ] || {
    log '--amendment, --relabel-launch, --manifest, --worklists, --runner-summary and --out are required'; echo 'ADS1_PULL_VERDICT=INDETERMINATE'; exit 3; }
  local root; root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo 'ADS1_PULL_VERDICT=INDETERMINATE'; exit 3; }
  cd "$root" || { log "cannot cd to $root"; echo 'ADS1_PULL_VERDICT=INDETERMINATE'; exit 3; }
  log "R11 run conditions at $(date -u +%FT%TZ):"
  # ── R11: every condition is checked and printed; the first false one is the WAIT reason ──
  local hm; hm=$((10#$(date -u +%H) * 60 + 10#$(date -u +%M)))
  in_window "$hm" || { wait_line "outside-06:30-17:45Z($(date -u +%H:%M)Z)"; exit 3; }
  log '  clock inside 06:30–17:45Z — yes'
  [ -f dist/scripts/ads1-scorecard.js ] && [ -f dist/scripts/lrw/completeness.js ] && [ -f dist/scripts/ads1/spec.js ] || {
    log 'dist/ missing — npm run build first'; echo 'ADS1_PULL_VERDICT=INDETERMINATE'; exit 3; }
  [ -r "$LRW_PULL" ] || { log "$LRW_PULL missing"; echo 'ADS1_PULL_VERDICT=INDETERMINATE'; exit 3; }
  mkdir -p "$out" || { log "cannot create $out"; echo 'ADS1_PULL_VERDICT=INDETERMINATE'; exit 3; }
  local start_s; start_s="$(date -u +%s)"
  local t_cut; t_cut="$(node -e "console.log(require('./dist/scripts/ads1/spec.js').T_CUT)")" || { echo 'ADS1_PULL_VERDICT=INDETERMINATE'; exit 3; }
  grep -qE '^[0-9]+(\.[0-9]+)?$' <<<"$launch" || { wait_line "relabel-launch-not-a-number('$launch')"; exit 3; }
  awk -v l="$launch" -v c="$t_cut" -v n="$start_s" 'BEGIN { exit !(l >= c && l < n) }' || { wait_line "relabel-launch-not-in-[T_CUT,now)($launch)"; exit 3; }
  log "  relabel launch $launch ≥ T_CUT $t_cut — yes"
  git fetch origin --quiet 2>/dev/null || { wait_line 'git-fetch-failed'; exit 3; }
  git merge-base --is-ancestor "$REG_COMMIT" origin/main 2>/dev/null || { wait_line 'registration-not-on-origin-main'; exit 3; }
  git merge-base --is-ancestor "$amend" origin/main 2>/dev/null || { wait_line "amendment-not-on-origin-main($amend)"; exit 3; }
  [ "$(introduces_amendment "$amend")" = yes ] || { wait_line "amendment-does-not-introduce-the-amendment-heading($amend)"; exit 3; }
  local reg_ts am_ts; reg_ts="$(git log -1 --format=%ct "$REG_COMMIT" 2>/dev/null)"; am_ts="$(git log -1 --format=%ct "$amend" 2>/dev/null)"
  [ -n "$reg_ts" ] && [ -n "$am_ts" ] && [ "$reg_ts" -lt "$start_s" ] && [ "$am_ts" -lt "$start_s" ] || { wait_line 'commits-not-before-the-pull'; exit 3; }
  log "  registration $REG_COMMIT @ $reg_ts and amendment $amend @ $am_ts on origin/main, before the pull — yes"
  local runs; runs="$(gh run list --workflow deploy.yml --limit 3 --json status --jq '.[].status' 2>/dev/null)" || { wait_line 'gh-run-list-unreadable'; exit 3; }
  [ -n "$runs" ] || { wait_line 'gh-run-list-empty'; exit 3; }
  grep -qvx 'completed' <<<"$runs" && { wait_line 'deploy-in-flight'; exit 3; }
  log '  no Deploy run in flight — yes'
  local vroot verify mirror
  vroot="$( . scripts/lib/system-map-path.sh && dirname "$ALGOVAULT_SYSTEM_MAP_PATH")" || { wait_line 'vault-root-unresolved'; exit 3; }
  verify="$vroot/Claude files/repo-preregistrations/_verify.sh"
  [ -r "$verify" ] || { wait_line 'mirror-verifier-missing'; exit 3; }
  mirror="$(bash "$verify" 2>/dev/null | grep -E '^PREREG_MIRROR_VERDICT=' | tail -n 1)"
  [ "$mirror" = 'PREREG_MIRROR_VERDICT=PASS' ] || { wait_line "mirror(${mirror:-none})"; exit 3; }
  log '  PREREG_MIRROR_VERDICT=PASS — yes'
  local wp alive; wp="$(lrw_writer_pattern)" || { wait_line 'lrw-writer-pattern-unreadable'; exit 3; }
  alive="$(ssh -o ConnectTimeout=20 -i "$KEY" "$HOST" "pgrep -fc '$wp' || true" 2>/dev/null)" || { wait_line 'host-unreachable'; exit 3; }
  [ "${alive:-x}" = 0 ] || { wait_line "writer-alive(${alive:-?})"; exit 3; }
  log '  no labeller / relabel runner / annotation alive on signal-1 — yes'
  local st; st="$(lrw_summary_state "$summary")"
  [ "$st" = ok ] || { wait_line "lrw-runner-summary($st)"; exit 3; }
  ro_probe "$out/pre-missing-v2.txt" "$(node dist/scripts/lrw/completeness.js --emit MISSING_V2)" &&
    ro_probe "$out/pre-null-v1-gap.txt" "$(node dist/scripts/lrw/completeness.js --emit NULL_V1_GAP)" || { wait_line 'lrw-done-probe-unreadable'; exit 3; }
  local rel ann
  rel="$(node dist/scripts/lrw/completeness.js --relabel --missing "$out/pre-missing-v2.txt" --manifest "$manifest")"
  ann="$(node dist/scripts/lrw/completeness.js --annotation --null-keys "$out/pre-null-v1-gap.txt" --worklists "$worklists")"
  printf '%s\n%s\n' "$rel" "$ann" > "$out/pre-completeness.txt"
  log "  $rel"; log "  $ann"
  case "$rel" in LRW_RELABEL_COMPLETE=YES*) ;; *) wait_line "lrw-relabel-not-done(${rel%% *})"; exit 3 ;; esac
  case "$ann" in LRW_ANNOTATION_COMPLETE=YES*) ;; *) wait_line "lrw-annotation-not-done(${ann%% *})"; exit 3 ;; esac
  log 'R11: every run condition holds — the registered session starts'

  # ── R12: the four parts, then the tier instrument ──
  local tokens=ind counters=ind files=ind before="" after="" pstart pend
  pstart="$(date -u +%s)"
  if ro_session counters "$out/part1-counters-before.txt" && ro_session extract "$out/part2-extract.txt" &&
     ro_session labelfree "$out/part3-labelfree.txt" && ro_session counters "$out/part4-counters-after.txt"; then
    tokens=ok
    local f
    for f in part1-counters-before part2-extract part3-labelfree part4-counters-after; do
      [ "$(head -n 1 "$out/$f.txt")" = "$RO_TOKEN" ] || tokens=fail
    done
    before="$(grep -m 1 '^COUNTERS ' "$out/part1-counters-before.txt")"; after="$(grep -m 1 '^COUNTERS ' "$out/part4-counters-after.txt")"
    if [ -n "$before" ] && [ "$before" = "$after" ]; then counters=equal; elif [ -n "$before" ]; then counters=moved; fi
    # COPY … HEADER always writes the header: the extract needs a DATA row (token + FAMILY + header + ≥ 1 row)
    local xlines; xlines="$(awk '/^===EXTRACT===$/{on=1; next} on' "$out/part2-extract.txt" | wc -l | tr -d ' ')"
    [ "${xlines:-0}" -gt 1 ] && grep -q '^===PRESENCE===$' "$out/part3-labelfree.txt" && files=ok
  else
    tokens=fail
  fi
  pend="$(date -u +%s)"
  local tiers_at; tiers_at="$(date -u +%FT%TZ)"
  curl -fsS --max-time 30 "$TIERS_URL" -o "$out/performance-public.json" || files=ind
  node -e '
    const [o, reg, regSha, regTs, am, amTs, launch, ps, pe, tiersAt, rel, ann] = process.argv.slice(1);
    require("fs").writeFileSync(o + "/pull-meta.json", JSON.stringify({
      registrationPath: reg, registrationCommit: regSha, registrationCommitTs: Number(regTs),
      amendmentCommit: am, amendmentCommitTs: Number(amTs), relabelLaunchTs: Number(launch),
      pullStartTs: Number(ps), pullEndTs: Number(pe), tiersFetchedAt: tiersAt, doneTokens: [rel, ann],
    }, null, 1) + "\n");
  ' "$out" "$REG_FILE" "$(git rev-parse "$REG_COMMIT")" "$reg_ts" "$(git rev-parse "$amend")" "$am_ts" "$launch" "$pstart" "$pend" "$tiers_at" "$rel" "$ann" \
    || files=ind
  [ -s "$out/pull-meta.json" ] || files=ind
  {
    echo "pull_start=$pstart pull_end=$pend registration=$REG_COMMIT@$reg_ts amendment=$amend@$am_ts relabel_launch=$launch"
    echo "tokens=$tokens counters=$counters files=$files"; echo "counters_before=$before"; echo "counters_after=$after"
    (cd "$out" && shasum -a 256 part2-extract.txt part3-labelfree.txt performance-public.json 2>/dev/null)
  } > "$out/pull-summary.txt"
  local rc; decide "$tokens" "$counters" "$files"; rc=$?
  exit "$rc"
}

self_test() {
  local pass=0 fail=0 cases=0
  ck() { # <name> <want line> <want rc> <command…>
    local name="$1" want="$2" want_rc="$3"; shift 3
    local got rc; got="$("$@" 2>/dev/null)"; rc=$?
    cases=$((cases + 1))
    if [ "$got" = "$want" ] && [ "$rc" -eq "$want_rc" ]; then pass=$((pass + 1)); echo "SELF-TEST: ok $name"
    else fail=$((fail + 1)); echo "SELF-TEST: FAIL $name (got '$got' rc=$rc)"; fi
  }
  ck all-pass 'ADS1_PULL_VERDICT=PASS' 0 decide ok equal ok
  ck token-not-read-only 'ADS1_PULL_VERDICT=FAIL' 1 decide fail equal ok
  ck concurrent-writer 'ADS1_PULL_VERDICT=FAIL' 1 decide ok moved ok
  ck counters-unread 'ADS1_PULL_VERDICT=INDETERMINATE' 3 decide ok ind ok
  ck outputs-missing 'ADS1_PULL_VERDICT=INDETERMINATE' 3 decide ok equal ind
  ck fail-outranks-ind 'ADS1_PULL_VERDICT=FAIL' 1 decide fail ind ind
  ck wait-is-exit-3 'ADS1_PULL_WAIT: deploy-in-flight' 3 wait_line deploy-in-flight
  # the window: 06:29 and 17:45 are outside, 06:30 and 17:44 inside
  local w=1 m
  for m in 389 1065; do in_window "$m" && w=0; done
  for m in 390 1064; do in_window "$m" || w=0; done
  cases=$((cases + 1)); if [ "$w" = 1 ]; then pass=$((pass + 1)); echo 'SELF-TEST: ok window-edges'; else fail=$((fail + 1)); echo 'SELF-TEST: FAIL window-edges'; fi
  # the writer pattern is LRW's (imported), and it never matches the remote shell's own command line
  local root wp ok=1; root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
  wp="$(cd "$root" && lrw_writer_pattern)"
  [ -n "$wp" ] || ok=0
  grep -Eq "$wp" <<<"pgrep -fc '$wp' || true" && ok=0
  grep -Eq "$wp" <<<'node dist/scripts/backfill-directional-labels.js --annotate-gaps' || ok=0
  cases=$((cases + 1)); if [ "$ok" = 1 ]; then pass=$((pass + 1)); echo 'SELF-TEST: ok lrw-writer-pattern-imported'; else fail=$((fail + 1)); echo 'SELF-TEST: FAIL lrw-writer-pattern-imported'; fi
  # the amendment must INTRODUCE §10: the registration commit itself touches the file and is refused
  cases=$((cases + 1))
  if [ "$(cd "$root" && introduces_amendment "$REG_COMMIT")" = no ]; then pass=$((pass + 1)); echo 'SELF-TEST: ok registration-commit-is-not-the-amendment'
  else fail=$((fail + 1)); echo 'SELF-TEST: FAIL registration-commit-is-not-the-amendment'; fi
  # pasting Dispatch B early is harmless: outside the window the real entry WAITs before any read (PATH has every
  # tool, so the guard that fires is the clock — the stub `date` pins 03:00Z)
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/ads1-pull-selftest.XXXXXX")" || { echo 'ADS1_PULL_SELFTEST: FAIL mktemp'; exit 1; }
  printf '#!/bin/sh\ncase "$*" in *%%H:%%M*) echo 03:00 ;; *%%H*) echo 03 ;; *%%M*) echo 00 ;; *%%s*) echo 1791000000 ;; *) echo 2026-10-03T03:00:00Z ;; esac\n' > "$tmp/date"
  chmod +x "$tmp/date"
  local out rc
  out="$(cd "$root" && env PATH="$tmp:$PATH" bash "${BASH_SOURCE[0]}" --amendment x --relabel-launch 1 --manifest m --worklists w --runner-summary s --out "$tmp/o" 2>/dev/null)"; rc=$?
  cases=$((cases + 1))
  if [ "$out" = 'ADS1_PULL_WAIT: outside-06:30-17:45Z(03:00Z)' ] && [ "$rc" -eq 3 ] && [ ! -e "$tmp/o/part2-extract.txt" ]; then
    pass=$((pass + 1)); echo 'SELF-TEST: ok early-paste-waits-before-any-read'
  else fail=$((fail + 1)); echo "SELF-TEST: FAIL early-paste-waits-before-any-read (got '$out' rc=$rc)"; fi
  # the missing-tool precondition, through the real entry point with a PATH that holds only bash
  ln -s "$(command -v bash)" "$tmp/bash"
  out="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" --amendment x --relabel-launch 1 --manifest m --worklists w --runner-summary s --out "$tmp/o2" 2>&1)"; rc=$?
  cases=$((cases + 1))
  if [ "$(tail -n 1 <<<"$out")" = 'ADS1_PULL_VERDICT=INDETERMINATE' ] && [ "$rc" -eq 3 ] && grep -q "required tool 'ssh' not on PATH" <<<"$out"; then
    pass=$((pass + 1)); echo 'SELF-TEST: ok missing-tool'
  else fail=$((fail + 1)); echo "SELF-TEST: FAIL missing-tool (got '$out' rc=$rc)"; fi
  rm -rf "$tmp"
  if [ "$cases" -lt 12 ]; then echo "ADS1_PULL_SELFTEST: FAIL vacuous ($cases cases)"; exit 1; fi
  if [ "$fail" -eq 0 ]; then echo "ADS1_PULL_SELFTEST: PASS ($pass checks)"; exit 0; fi
  echo "ADS1_PULL_SELFTEST: FAIL ($fail of $cases)"; exit 1
}

if (return 0 2>/dev/null); then return 0; fi
if [ "${1:-}" = "--self-test" ]; then self_test; fi
run_pull "$@"
