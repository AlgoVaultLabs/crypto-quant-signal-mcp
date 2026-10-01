#!/usr/bin/env bash
# oah-ch3-gate.sh — OPS-ADAPTER-HISTORY-ANCHOR-W1 CH3 (the live canary · inventory / interlock rows · the LRW
# amendment text).
#
# GREEN iff (the spec's AC, every leg a positive check):
#   1. the canary wrapper's --self-test prints SELF_TEST_VERDICT=PASS on this machine
#   2. the INSTALLED wrapper's --self-test prints SELF_TEST_VERDICT=PASS on signal-1, run the way cron runs it
#      (env -i, cron's PATH, cwd /)
#   3. signal-1's crontab carries the canary line `24 10 * * * /opt/algovault-monitoring/adapter-history-contiguity-canary.sh`
#   4. the commit that ADDED the wrapper also carries the inventory row and the interlock row
#   5. ops/scripts/monitoring-results-sync.sh prints MONITORING_RESULTS_SYNC_VERDICT=PASS and the vault's
#      canary-results.jsonl holds an `adapter-history-contiguity` record
#   6. the vault audit carries "LRW registration amendment (verbatim)" or AMENDMENT_SKIPPED
#   7. the vault status.md records `T_ADAPTER = <epoch> (<ISO>)`
# INDETERMINATE iff signal-1 is unreachable (legs 2, 3) or a tool is missing; RED otherwise.
#
# --local: legs 1 + 6 + 7 plus the pre-landing code legs — the canary unit suite ran and passed, the caller-tag
#   and dark-export gates PASS, and no changed path is in CH3's Must-NOT-write list (src/lib/adapters/*.ts ·
#   any labeler · the LRW registration · other canaries · a package.json "version" change). Prints
#   CH3_LOCAL_GREEN|CH3_LOCAL_RED|CH3_LOCAL_INDETERMINATE. It is the landing gate; the full gate is the chapter's.
#
# Verdict — exactly one terminal line; callers gate on the TOKEN: GREEN 0 · RED 1 · INDETERMINATE 3.
# RED outranks INDETERMINATE.
#
# --self-test: drives the REAL leg predicates and decide() over fixtures, two-way, then proves it can fail:
#   5 mutated copies of this script (each breaking one predicate) must each fail their own self-test.
# bash 3.2 compatible.
set -uo pipefail

WRAPPER='ops/monitoring/adapter-history-contiguity-canary.sh'
HOST_WRAPPER='/opt/algovault-monitoring/adapter-history-contiguity-canary.sh'
CRON_LINE="24 10 * * * $HOST_WRAPPER"
CANARY='adapter-history-contiguity'
UNIT_TEST='tests/unit/adapter-history-contiguity.test.ts'
VAULT="${OAH_VAULT:-$HOME/My Drive/Obsidian Vault/AlgoVault MCP}"
AUDIT="${OAH_AUDIT:-$VAULT/audits/OPS-ADAPTER-HISTORY-ANCHOR-W1-endpoint-truth.md}"
STATUS_MD="${OAH_STATUS_MD:-$VAULT/status.md}"
RESULTS_JSONL="${OAH_RESULTS_JSONL:-$VAULT/Claude files/canary-results.jsonl}"
SSH_TARGET="${OAH_SSH_TARGET:-root@204.168.185.24}"
SSH_KEY="${OAH_SSH_KEY:-$HOME/.ssh/algovault_deploy}"
MUST_NOT_WRITE='^src/lib/adapters/|^src/scripts/directional-labeler\.ts$|^src/scripts/backfill-[^/]+\.ts$|^src/scripts/lrw/|^audits/labeler-race-window-v2-preregistration|^ops/monitoring/[^/]+-canary\.(sh|py)$|\.env'
MUST_NOT_ALLOW='^ops/monitoring/adapter-history-contiguity-canary\.sh$'

log() { echo "[oah-ch3-gate] $*" >&2; }

# ── pure predicates (args → PASS|FAIL) ─────────────────────────────────────────────────────────
# Here-strings, never `printf | grep -q`: under pipefail an early-exiting grep -q SIGPIPEs the printf on a large
# input (status.md) and the pipeline reads as a miss — a false FAIL measured on this gate's first --local run.
selftest_ok() { grep -q '^SELF_TEST_VERDICT=PASS' <<<"$1" && echo PASS || echo FAIL; }
crontab_ok() { grep -vE '^[[:space:]]*#' <<<"$1" | grep -qF -- "$CRON_LINE" && echo PASS || echo FAIL; }
rows_ok() { # <name-only listing>
  if grep -qx 'ops/monitoring/monitoring-inventory.json' <<<"$1" \
     && grep -qx 'ops/scripts/cron-interlock-registry.json' <<<"$1" \
     && grep -qx "$WRAPPER" <<<"$1"; then echo PASS; else echo FAIL; fi
}
sync_ok() { # <sync output> <jsonl text>
  grep -q 'MONITORING_RESULTS_SYNC_VERDICT=PASS' <<<"$1" \
    && grep -q "\"canary\": *\"$CANARY\"" <<<"$2" && echo PASS || echo FAIL
}
amendment_ok() { grep -qE 'LRW registration amendment \(verbatim\)|AMENDMENT_SKIPPED' <<<"$1" && echo PASS || echo FAIL; }
t_adapter_ok() { grep -qE 'T_ADAPTER = [0-9]{10} \([0-9T:.-]+Z\)' <<<"$1" && echo PASS || echo FAIL; }
firewall_ok() { # <changed paths> <version-changed 0|1>
  local bad
  bad="$(grep -E "$MUST_NOT_WRITE" <<<"$1" | grep -vE "$MUST_NOT_ALLOW" || true)"
  if [ -n "$bad" ] || [ "$2" != 0 ]; then echo FAIL; else echo PASS; fi
}
decide() { # <leg results...> → GREEN|RED|INDETERMINATE
  local r red=0 ind=0
  for r in "$@"; do case "$r" in PASS) ;; FAIL) red=1 ;; *) ind=1 ;; esac; done
  if [ "$red" = 1 ]; then echo RED; elif [ "$ind" = 1 ]; then echo INDETERMINATE; else echo GREEN; fi
}

# ── I/O legs ───────────────────────────────────────────────────────────────────────────────────
ssh1() { ssh -o ConnectTimeout=12 -o BatchMode=yes -i "$SSH_KEY" "$SSH_TARGET" "$@"; }
leg_selftest_local() { selftest_ok "$(bash "$WRAPPER" --self-test 2>&1 | tail -1)"; }
leg_selftest_host() {
  local out
  out="$(ssh1 "cd / && env -i PATH=/usr/bin:/bin HOME=/root SHELL=/bin/sh $HOST_WRAPPER --self-test 2>&1 | tail -1")" || { echo INDETERMINATE; return; }
  log "host self-test: $out"; selftest_ok "$out"
}
leg_crontab() { local c; c="$(ssh1 'crontab -l' 2>/dev/null)" || { echo INDETERMINATE; return; }; crontab_ok "$c"; }
leg_rows() {
  local c; c="$(git log origin/main --diff-filter=A --format=%H -- "$WRAPPER" 2>/dev/null | tail -1)"
  [ -n "$c" ] || { log "no commit on origin/main adds $WRAPPER"; echo FAIL; return; }
  log "canary commit: ${c:0:8}"; rows_ok "$(git show --name-only --format= "$c")"
}
leg_sync() {
  local out; out="$(bash ops/scripts/monitoring-results-sync.sh 2>&1 | tail -5)"
  log "results sync: $(printf '%s' "$out" | grep -o 'MONITORING_RESULTS_SYNC_VERDICT=[A-Z]*' | tail -1)"
  sync_ok "$out" "$(cat "$RESULTS_JSONL" 2>/dev/null)"
}
leg_amendment() { [ -r "$AUDIT" ] || { echo INDETERMINATE; return; }; amendment_ok "$(cat "$AUDIT")"; }
leg_t_adapter() { [ -r "$STATUS_MD" ] || { echo INDETERMINATE; return; }; t_adapter_ok "$(cat "$STATUS_MD")"; }
leg_unit() {
  local out; out="$(npx vitest run "$UNIT_TEST" 2>&1 | tail -6)"
  printf '%s\n' "$out" | grep -qE 'Tests +[0-9]+ passed' && ! printf '%s\n' "$out" | grep -qE '[0-9]+ failed' && echo PASS || echo FAIL
}
leg_token() { # <cmd...> <TOKEN_NAME>
  local name="${*: -1}" out
  out="$("${@:1:$#-1}" 2>&1 | tail -3)"
  case "$(printf '%s\n' "$out" | grep -o "${name}=[A-Z]*" | tail -1 | cut -d= -f2)" in
    PASS) echo PASS ;; FAIL) echo FAIL ;; *) echo INDETERMINATE ;;
  esac
}
leg_firewall() {
  local base changed vchg=0
  base="$(git merge-base HEAD origin/main)"
  changed="$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } | sort -u)"
  git diff "$base" -- package.json | grep -qE '^[-+][[:space:]]*"version":' && vchg=1
  firewall_ok "$changed" "$vchg"
}

emit() { # <prefix> <verdict>
  local code=3; case "$2" in GREEN) code=0 ;; RED) code=1 ;; esac
  echo "${1}_${2}"; exit "$code"
}

self_test() {
  local checked=0 fails=""
  ck() { checked=$((checked + 1)); if [ "$2" = "$3" ]; then echo "SELF-TEST: ok   $1"; else echo "SELF-TEST: FAIL $1 (got '$2', want '$3')"; fails="$fails|$1"; fi; }
  ck 'self-test PASS line' "$(selftest_ok 'SELF_TEST_VERDICT=PASS — 41 assertions')" PASS
  ck 'self-test FAIL line' "$(selftest_ok 'SELF_TEST_VERDICT=FAIL — x')" FAIL
  ck 'self-test no line' "$(selftest_ok '')" FAIL
  ck 'crontab carries the line' "$(crontab_ok "$(printf '13 * * * * /x\n%s\n' "$CRON_LINE")")" PASS
  ck 'crontab without the line' "$(crontab_ok '13 * * * * /x')" FAIL
  ck 'crontab with the line COMMENTED OUT' "$(crontab_ok "# $CRON_LINE")" FAIL
  ck 'crontab with another minute' "$(crontab_ok "25 10 * * * $HOST_WRAPPER")" FAIL
  ck 'rows in the canary commit' "$(rows_ok "$(printf '%s\n' "$WRAPPER" ops/monitoring/monitoring-inventory.json ops/scripts/cron-interlock-registry.json)")" PASS
  ck 'interlock row missing' "$(rows_ok "$(printf '%s\n' "$WRAPPER" ops/monitoring/monitoring-inventory.json)")" FAIL
  ck 'inventory row missing' "$(rows_ok "$(printf '%s\n' "$WRAPPER" ops/scripts/cron-interlock-registry.json)")" FAIL
  ck 'sync PASS + record' "$(sync_ok 'MONITORING_RESULTS_SYNC_VERDICT=PASS' '{"canary": "adapter-history-contiguity"}')" PASS
  ck 'sync PASS, compact record' "$(sync_ok 'MONITORING_RESULTS_SYNC_VERDICT=PASS' '{"canary":"adapter-history-contiguity"}')" PASS
  ck 'sync PASS, no record' "$(sync_ok 'MONITORING_RESULTS_SYNC_VERDICT=PASS' '{"canary": "lifecycle-readout"}')" FAIL
  ck 'sync INDETERMINATE' "$(sync_ok 'MONITORING_RESULTS_SYNC_VERDICT=INDETERMINATE' '{"canary": "adapter-history-contiguity"}')" FAIL
  ck 'amendment present' "$(amendment_ok '## LRW registration amendment (verbatim)')" PASS
  ck 'amendment skipped' "$(amendment_ok 'AMENDMENT_SKIPPED: pull already taken')" PASS
  ck 'amendment absent' "$(amendment_ok '## something else')" FAIL
  ck 'T_ADAPTER recorded' "$(t_adapter_ok 'T_ADAPTER = 1790864836 (2026-10-01T14:27:16.460Z)')" PASS
  ck 'T_ADAPTER placeholder' "$(t_adapter_ok 'T_ADAPTER = <epoch> (<ISO>)')" FAIL
  ck 'firewall clean' "$(firewall_ok "$(printf '%s\n' src/scripts/adapter-history-contiguity.ts "$WRAPPER" ops/monitoring/alert-registry.json)" 0)" PASS
  ck 'firewall: an adapter' "$(firewall_ok 'src/lib/adapters/okx.ts' 0)" FAIL
  ck 'firewall: another canary' "$(firewall_ok 'ops/monitoring/book-liveness-canary.py' 0)" FAIL
  ck 'firewall: the labeler' "$(firewall_ok 'src/scripts/directional-labeler.ts' 0)" FAIL
  ck 'firewall: a version bump' "$(firewall_ok 'src/scripts/adapter-history-contiguity.ts' 1)" FAIL
  ck 'decide: all PASS' "$(decide PASS PASS PASS)" GREEN
  ck 'decide: one FAIL' "$(decide PASS FAIL PASS)" RED
  ck 'decide: one INDETERMINATE' "$(decide PASS INDETERMINATE)" INDETERMINATE
  ck 'decide: RED outranks INDETERMINATE' "$(decide INDETERMINATE FAIL)" RED
  ck 'decide: an empty leg is not a pass' "$(decide PASS '')" INDETERMINATE

  if [ -z "${OAH_CH3_NO_MUTATE:-}" ]; then
    # Prove the self-test can fail: each mutated copy must FAIL its own self-test.
    local m n=0 me tmpd
    me="$0"; tmpd="$(mktemp -d)"
    while IFS='~' read -r name from to; do
      n=$((n + 1))
      python3 -c 'import sys; s=open(sys.argv[1]).read(); a,b=sys.argv[2],sys.argv[3]; assert a in s, a; open(sys.argv[4],"w").write(s.replace(a,b,1))' \
        "$me" "$from" "$to" "$tmpd/m$n.sh" 2>/dev/null || { ck "mutation $n ($name) applies" missing present; continue; }
      m="$(OAH_CH3_NO_MUTATE=1 bash "$tmpd/m$n.sh" --self-test 2>&1 | tail -1)"
      ck "mutation $n ($name) is caught" "$(printf '%s' "$m" | grep -o 'SELF_TEST_VERDICT=[A-Z]*')" SELF_TEST_VERDICT=FAIL
    done <<'MUT'
comment-blind crontab~grep -vE '^[[:space:]]*#' <<<"$1" | grep -qF -- "$CRON_LINE"~grep -qF -- "$CRON_LINE" <<<"$1"
interlock not required~grep -qx 'ops/scripts/cron-interlock-registry.json'~grep -q ''
sync ignores the record~grep -q "\"canary\": *\"$CANARY\"" <<<"$2"~grep -q '' <<<"$2"
firewall lets adapters through~MUST_NOT_WRITE='^src/lib/adapters/|~MUST_NOT_WRITE='^src/lib/adapterz/|
INDETERMINATE reads as PASS~case "$r" in PASS) ;; FAIL)~case "$r" in PASS|'') ;; FAIL)
MUT
    rm -rf "$tmpd"
  fi

  if [ "$checked" -lt 29 ]; then echo "SELF_TEST_VERDICT=INDETERMINATE — only $checked assertions ran"; return 3; fi
  if [ -n "$fails" ]; then echo "SELF_TEST_VERDICT=FAIL — ${fails#|}"; return 1; fi
  echo "SELF_TEST_VERDICT=PASS — $checked assertions (two-way fixtures + 5 mutation proofs)"; return 0
}

# Sourceable for tests: stop here when sourced.
(return 0 2>/dev/null) && return 0

case "${1:-}" in
  --self-test) self_test; exit $? ;;
  --local)
    for t in node npx git python3; do command -v "$t" >/dev/null 2>&1 || { log "missing tool $t"; emit CH3_LOCAL INDETERMINATE; }; done
    L1="$(leg_selftest_local)"; log "canary self-test (local): $L1"
    L2="$(leg_unit)"; log "canary unit suite: $L2"
    L3="$(leg_token node scripts/check-caller-tags.mjs CALLER_TAG_VERDICT)"; log "caller tags: $L3"
    L4="$(leg_token node scripts/check-new-dark-exports.mjs DARK_EXPORTS_VERDICT)"; log "dark exports: $L4"
    L5="$(leg_firewall)"; log "firewall: $L5"
    L6="$(leg_amendment)"; log "LRW amendment text: $L6"
    L7="$(leg_t_adapter)"; log "T_ADAPTER recorded: $L7"
    emit CH3_LOCAL "$(decide "$L1" "$L2" "$L3" "$L4" "$L5" "$L6" "$L7")" ;;
  *)
    for t in node git python3 ssh; do command -v "$t" >/dev/null 2>&1 || { log "missing tool $t"; emit CH3 INDETERMINATE; }; done
    L1="$(leg_selftest_local)"; log "canary self-test (local): $L1"
    L2="$(leg_selftest_host)"; log "canary self-test (signal-1, as cron): $L2"
    L3="$(leg_crontab)"; log "crontab row: $L3"
    L4="$(leg_rows)"; log "inventory + interlock rows in the canary commit: $L4"
    L5="$(leg_sync)"; log "results sync + record: $L5"
    L6="$(leg_amendment)"; log "LRW amendment text: $L6"
    L7="$(leg_t_adapter)"; log "T_ADAPTER recorded: $L7"
    emit CH3 "$(decide "$L1" "$L2" "$L3" "$L4" "$L5" "$L6" "$L7")" ;;
esac
