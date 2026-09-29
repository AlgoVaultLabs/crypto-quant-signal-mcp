#!/usr/bin/env bash
# cce-ch3-gate.sh — OPS-CLIENT-CLAIM-EVIDENCE-W1 CH3 (cutover on signal-1, the runbook, the map).
#
# A canary is only fixed where the scheduler runs it. Legs, in order (every ssh leg is read-only with
# respect to production state — the proof run below writes its state and log to mktemp paths on the
# host and removes them):
#   1. INSTALL — sha256 of the host artifact == the inventory row's sha256 == this checkout's file,
#      and a timestamped backup `client-claim-freshness.py.bak.OPS-CLIENT-CLAIM-EVIDENCE-W1-*` exists.
#   2. CRON-SHAPED RUN — as root, `env -i` with cron's PATH, ALGOVAULT_TG_TEST_INERT=1, a mktemp state
#      file and log: exactly one terminal token (PASS or FAIL — INDETERMINATE is not a cutover), one
#      positive EVAL line per corpus row (the row count read from the committed claim-evidence.json),
#      no row both freshly confirmed and stale, every contradicted row naming >= 1 contradicted anchor.
#   3. RECONCILER — on the real synced declaration, MONITORING_STATE_DIR=$(mktemp -d), INERT:
#      HASH_DRIFT / REGISTRY_PARITY / NO_BACKUP / SCHEDULE_DRIFT all `OK` for client-claim-freshness.
#   4. MAP — npm run map:shape:check -> SYSTEM_MAP_SHAPE_VERDICT=PASS; npm run map:edges:check ->
#      MAP_EDGES_VERDICT=PASS.
#   5. RUNBOOK — the vault monitoring runbook carries a `## CLIENT_CLAIM_DRIFT` section (vault path
#      derived from scripts/lib/system-map-path.sh — the ONE definition of where the vault is).
#
# Verdict — exactly one terminal line, the token is the contract:
#   CH3_GREEN          exit 0   every leg passed
#   CH3_RED            exit 1   any leg failed
#   CH3_INDETERMINATE  exit 3   the host is unreachable, a tool is missing, or a leg produced no verdict
#
# Usage:  bash scripts/gates/cce-ch3-gate.sh
#         bash scripts/gates/cce-ch3-gate.sh --self-test
set -uo pipefail

REQUIRED_TOOLS=(node npm python3 git grep shasum ssh)
HOST="${CCE_CH3_HOST:-root@204.168.185.24}"
SSH_KEY="${CCE_CH3_SSH_KEY:-$HOME/.ssh/algovault_deploy}"
HOST_CANARY='/opt/algovault-monitoring/client-claim-freshness.py'
HOST_RECONCILER='/opt/algovault-monitoring/monitoring-inventory-reconcile.py'
ROW='client-claim-freshness'

# decide <install> <run> <reconcile> <shape> <edges> <runbook>
#   install:   ok | mismatch:<why> | "" (could not read)
#   run:       ok | bad:<why> | "" (no readable output)
#   reconcile: ok | bad:<why> | ""
#   shape:     PASS | FAIL | ""          edges: PASS | FAIL | ""
#   runbook:   present | absent | ""
decide() {
  local install="$1" run="$2" rec="$3" shape="$4" edges="$5" rb="$6"
  local red="" ind=""
  case "$install" in ok) ;; mismatch:*) red="$red install(${install#mismatch:})" ;; *) ind="$ind install:unreadable" ;; esac
  case "$run" in ok) ;; bad:*) red="$red cron-run(${run#bad:})" ;; *) ind="$ind cron-run:no-output" ;; esac
  case "$rec" in ok) ;; bad:*) red="$red reconciler(${rec#bad:})" ;; *) ind="$ind reconciler:no-output" ;; esac
  case "$shape" in PASS) ;; FAIL) red="$red map-shape" ;; *) ind="$ind map-shape:${shape:-none}" ;; esac
  case "$edges" in PASS) ;; FAIL) red="$red map-edges" ;; *) ind="$ind map-edges:${edges:-none}" ;; esac
  case "$rb" in present) ;; absent) red="$red runbook-section" ;; *) ind="$ind runbook:unreadable" ;; esac
  if [ -n "$red" ]; then printf '[cce-ch3-gate] RED:%s%s\n' "$red" "${ind:+ (also unverified:$ind)}" >&2; echo CH3_RED; return 1; fi
  if [ -n "$ind" ]; then printf '[cce-ch3-gate] cannot verify:%s\n' "$ind" >&2; echo CH3_INDETERMINATE; return 3; fi
  printf '[cce-ch3-gate] install parity + cron-shaped run + reconciler + map + runbook all passed\n' >&2
  echo CH3_GREEN; return 0
}

# judge_run <stdout-file> <expected-rows> <today>  -> ok | bad:<why>   (pure: the self-test drives it)
judge_run() {
  local f="$1" rows="$2" today="$3"
  local toks evals
  toks="$(grep -cE '^CLIENT_CLAIM_FRESHNESS_VERDICT=(PASS|FAIL|INDETERMINATE)$' "$f" || true)"
  [ "$toks" = "1" ] || { echo "bad:token-lines=$toks"; return; }
  grep -qE '^CLIENT_CLAIM_FRESHNESS_VERDICT=(PASS|FAIL)$' "$f" || { echo "bad:token=$(grep -E '^CLIENT_CLAIM_FRESHNESS_VERDICT=' "$f")"; return; }
  evals="$(grep -cE '\] EVAL module=' "$f" || true)"
  [ "$evals" = "$rows" ] || { echo "bad:eval-lines=$evals-of-$rows"; return; }
  if grep -E '\] EVAL module=' "$f" | grep -E "confirmed=$today " | grep -qE ' state=stale '; then
    echo "bad:a-row-confirmed-today-reads-stale"; return
  fi
  local line
  while IFS= read -r line; do
    printf '%s' "$line" | grep -qE ' a[0-9]+=contradicted' || { echo "bad:contradicted-row-names-no-anchor"; return; }
  done < <(grep -E '\] EVAL module=' "$f" | grep -E ' state=contradicted ')
  echo ok
}

# judge_reconcile <log-file> -> ok | bad:<why>
judge_reconcile() {
  local f="$1" chk missing=""
  for chk in HASH_DRIFT REGISTRY_PARITY NO_BACKUP SCHEDULE_DRIFT; do
    if ! grep -qE "\] $chk [a-z0-9-]+ $ROW OK( |$)" "$f"; then missing="$missing,$chk"; fi
  done
  if [ -n "$missing" ]; then echo "bad:not-OK${missing}"; else echo ok; fi
}

run_gate() {
  local t
  for t in "${REQUIRED_TOOLS[@]}"; do
    command -v "$t" >/dev/null 2>&1 || { printf "[cce-ch3-gate] required tool '%s' not on PATH\n" "$t" >&2; echo CH3_INDETERMINATE; exit 3; }
  done
  local root; root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "[cce-ch3-gate] not inside a git checkout" >&2; echo CH3_INDETERMINATE; exit 3; }
  cd "$root" || { echo CH3_INDETERMINATE; exit 3; }
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/cce-ch3-gate.XXXXXX")" || { echo CH3_INDETERMINATE; exit 3; }
  local SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=12 "$HOST")

  local install="" run="" rec="" shape="" edges="" rb=""
  # 1 — install parity + backup
  local want got host_sha bak
  want="$(node -e '
    const inv = JSON.parse(require("fs").readFileSync("ops/monitoring/monitoring-inventory.json", "utf8"));
    const row = (inv.artifacts || []).find((a) => a.id === process.argv[1]);
    console.log(row && typeof row.sha256 === "string" ? row.sha256 : "");' "$ROW" 2>/dev/null)"
  got="$(shasum -a 256 ops/monitoring/client-claim-freshness.py 2>/dev/null | awk '{print $1}')"
  host_sha="$("${SSH[@]}" "sha256sum $HOST_CANARY | awk '{print \$1}'" 2>/dev/null)"
  bak="$("${SSH[@]}" "ls -1 ${HOST_CANARY}.bak.OPS-CLIENT-CLAIM-EVIDENCE-W1-* 2>/dev/null | tail -n 1" 2>/dev/null)"
  if [ -n "$want" ] && [ -n "$got" ] && [ -n "$host_sha" ]; then
    if [ "$want" != "$got" ]; then install="mismatch:inventory-vs-repo"
    elif [ "$host_sha" != "$got" ]; then install="mismatch:host-vs-repo"
    elif [ -z "$bak" ]; then install="mismatch:no-wave-backup"
    else install=ok; fi
  fi

  # 2 — cron-shaped run (production state untouched: mktemp state + log, removed after)
  local rows today
  rows="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("src/lib/integrations-data/claim-evidence.json","utf8")).rows.length)' 2>/dev/null)"
  today="$(date -u +%Y-%m-%d)"
  "${SSH[@]}" "S=\$(mktemp -d); env -i HOME=/root LOGNAME=root SHELL=/bin/sh PATH=/usr/bin:/bin ALGOVAULT_TG_TEST_INERT=1 CLIENT_CLAIM_STATE=\$S/state.json CLIENT_CLAIM_LOG=\$S/run.log $HOST_CANARY; rc=\$?; rm -rf \$S; echo \"__RC__=\$rc\"" \
    >"$tmp/cron-run.txt" 2>&1 || true
  if [ -s "$tmp/cron-run.txt" ] && [ -n "$rows" ]; then run="$(judge_run "$tmp/cron-run.txt" "$rows" "$today")"; fi

  # 3 — reconciler on the real synced declaration (alert state in a temp dir; inert)
  "${SSH[@]}" "D=\$(mktemp -d); MONITORING_STATE_DIR=\$D ALGOVAULT_TG_TEST_INERT=1 $HOST_RECONCILER 2>&1 | grep -E ' $ROW '; rm -rf \$D" \
    >"$tmp/reconcile.txt" 2>&1 || true
  if [ -s "$tmp/reconcile.txt" ]; then rec="$(judge_reconcile "$tmp/reconcile.txt")"; fi

  # 4 — map tokens
  shape="$(npm run -s map:shape:check 2>/dev/null | grep -E '^SYSTEM_MAP_SHAPE_VERDICT=' | tail -n 1 | sed 's/^SYSTEM_MAP_SHAPE_VERDICT=//')"
  edges="$(npm run -s map:edges:check 2>/dev/null | grep -E '^MAP_EDGES_VERDICT=' | tail -n 1 | sed 's/^MAP_EDGES_VERDICT=//')"

  # 5 — runbook section, vault located through the ONE shared path definition
  local vault_map runbook
  vault_map="$( . scripts/lib/system-map-path.sh 2>/dev/null; printf '%s' "${ALGOVAULT_SYSTEM_MAP_PATH:-}" )"
  if [ -n "$vault_map" ]; then
    runbook="$(dirname "$vault_map")/Claude files/monitoring-runbook.md"
    if [ -r "$runbook" ]; then
      if grep -qE '^## CLIENT_CLAIM_DRIFT' "$runbook"; then rb=present; else rb=absent; fi
    fi
  fi

  printf '[cce-ch3-gate] install=%s (row %s, repo %s, host %s, backup %s)\n[cce-ch3-gate] cron-run=%s (%s rows expected)\n[cce-ch3-gate] reconciler=%s\n[cce-ch3-gate] map-shape=%s map-edges=%s runbook=%s\n' \
    "${install:-unreadable}" "${want:0:12}" "${got:0:12}" "${host_sha:0:12}" "${bak:-none}" "${run:-no-output}" "${rows:-?}" "${rec:-no-output}" "${shape:-none}" "${edges:-none}" "${rb:-unreadable}" >&2
  local rc
  decide "$install" "$run" "$rec" "$shape" "$edges" "$rb"; rc=$?
  if [ "$rc" -eq 0 ]; then rm -rf "$tmp"
  else printf '[cce-ch3-gate] evidence kept: %s\n' "$tmp" >&2; fi
  exit "$rc"
}

self_test() {
  local pass=0 fail=0 cases=0
  check() { # <name> <want token> <want rc> <decide args...>
    local name="$1" want="$2" want_rc="$3"; shift 3
    local out rc
    out="$(decide "$@" 2>/dev/null)"; rc=$?
    cases=$((cases + 1))
    if [ "$out" = "$want" ] && [ "$rc" -eq "$want_rc" ]; then pass=$((pass + 1)); echo "SELF-TEST: ok $name"
    else fail=$((fail + 1)); echo "SELF-TEST: FAIL $name (got '$out' rc=$rc, want '$want' rc=$want_rc)"; fi
  }
  check all-pass-green CH3_GREEN 0 ok ok ok PASS PASS present
  check install-mismatch-red CH3_RED 1 mismatch:host-vs-repo ok ok PASS PASS present
  check cron-run-bad-red CH3_RED 1 ok bad:eval-lines=11-of-12 ok PASS PASS present
  check reconciler-bad-red CH3_RED 1 ok ok bad:not-OK,HASH_DRIFT PASS PASS present
  check map-shape-fail-red CH3_RED 1 ok ok ok FAIL PASS present
  check map-edges-fail-red CH3_RED 1 ok ok ok PASS FAIL present
  check runbook-absent-red CH3_RED 1 ok ok ok PASS PASS absent
  check host-unreachable-indeterminate CH3_INDETERMINATE 3 "" "" "" PASS PASS present
  check map-token-missing-indeterminate CH3_INDETERMINATE 3 ok ok ok "" PASS present
  check runbook-unreadable-indeterminate CH3_INDETERMINATE 3 ok ok ok PASS PASS ""
  check red-outranks-indeterminate CH3_RED 1 mismatch:no-wave-backup "" "" "" "" ""

  # judge_run / judge_reconcile over fixtures — the parsers the live legs depend on
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/cce-ch3-selftest.XXXXXX")" || { echo "CCE_CH3_GATE_SELFTEST: FAIL mktemp"; exit 1; }
  local E='[2026-09-30T02:17:05Z] EVAL module=mcp-clients'
  {
    echo "$E slug=a kind=native verifiedAt=2026-04-30 confirmed=2026-09-30 age=0d state=confirmed evidence=confirmed anchors=1/1 a1=confirmed"
    echo "$E slug=b kind=native verifiedAt=2026-08-05 confirmed=never age=56d state=contradicted evidence=contradicted anchors=0/1 a1=contradicted"
    echo "CLIENT_CLAIM_FRESHNESS_VERDICT=FAIL"
  } >"$tmp/good.txt"
  jcheck() { # <name> <want> <got>
    cases=$((cases + 1))
    if [ "$3" = "$2" ]; then pass=$((pass + 1)); echo "SELF-TEST: ok $1"
    else fail=$((fail + 1)); echo "SELF-TEST: FAIL $1 (got '$3', want '$2')"; fi
  }
  jcheck judge-run-good ok "$(judge_run "$tmp/good.txt" 2 2026-09-30)"
  jcheck judge-run-row-count bad:eval-lines=2-of-3 "$(judge_run "$tmp/good.txt" 3 2026-09-30)"
  sed 's/^CLIENT_CLAIM_FRESHNESS_VERDICT=FAIL$/CLIENT_CLAIM_FRESHNESS_VERDICT=INDETERMINATE/' "$tmp/good.txt" >"$tmp/ind.txt"
  jcheck judge-run-indeterminate-is-not-a-cutover "bad:token=CLIENT_CLAIM_FRESHNESS_VERDICT=INDETERMINATE" "$(judge_run "$tmp/ind.txt" 2 2026-09-30)"
  { cat "$tmp/good.txt"; echo "CLIENT_CLAIM_FRESHNESS_VERDICT=PASS"; } >"$tmp/two.txt"
  jcheck judge-run-two-tokens bad:token-lines=2 "$(judge_run "$tmp/two.txt" 2 2026-09-30)"
  sed 's/state=confirmed evidence=confirmed/state=stale evidence=confirmed/' "$tmp/good.txt" >"$tmp/stale.txt"
  jcheck judge-run-confirmed-and-stale bad:a-row-confirmed-today-reads-stale "$(judge_run "$tmp/stale.txt" 2 2026-09-30)"
  sed 's/anchors=0\/1 a1=contradicted/anchors=0\/1 a1=unreachable/' "$tmp/good.txt" >"$tmp/noanchor.txt"
  jcheck judge-run-contradicted-without-anchor bad:contradicted-row-names-no-anchor "$(judge_run "$tmp/noanchor.txt" 2 2026-09-30)"
  local R='[2026-09-30T06:57:38+00:00]'
  printf '%s HASH_DRIFT signal-1 %s OK x\n%s REGISTRY_PARITY signal-1 %s OK x\n%s NO_BACKUP signal-1 %s OK path=y\n%s SCHEDULE_DRIFT signal-1 %s OK z\n' \
    "$R" "$ROW" "$R" "$ROW" "$R" "$ROW" "$R" "$ROW" >"$tmp/rec.txt"
  jcheck judge-reconcile-all-ok ok "$(judge_reconcile "$tmp/rec.txt")"
  sed 's/HASH_DRIFT signal-1 client-claim-freshness OK/HASH_DRIFT signal-1 client-claim-freshness DRIFT/' "$tmp/rec.txt" >"$tmp/rec2.txt"
  jcheck judge-reconcile-hash-drift bad:not-OK,HASH_DRIFT "$(judge_reconcile "$tmp/rec2.txt")"

  # the missing-tool precondition, through the real entry point
  ln -s "$(command -v bash)" "$tmp/bash"
  local out rc errtxt
  errtxt="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>&1 >/dev/null)"
  out="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>/dev/null)"; rc=$?
  rm -rf "$tmp"
  cases=$((cases + 1))
  if [ "$out" = "CH3_INDETERMINATE" ] && [ "$rc" -eq 3 ] && printf '%s' "$errtxt" | grep -q "required tool 'node'"; then
    pass=$((pass + 1)); echo "SELF-TEST: ok missing-tool-indeterminate"
  else fail=$((fail + 1)); echo "SELF-TEST: FAIL missing-tool-indeterminate (got '$out' rc=$rc)"; fi
  if [ "$cases" -lt 20 ]; then echo "CCE_CH3_GATE_SELFTEST: FAIL vacuous ($cases cases)"; exit 1; fi
  if [ "$fail" -eq 0 ]; then echo "CCE_CH3_GATE_SELFTEST: PASS ($pass checks)"; exit 0; fi
  echo "CCE_CH3_GATE_SELFTEST: FAIL ($fail of $cases)"; exit 1
}

# sourceable: when sourced, define the functions and stop (no gate run)
if (return 0 2>/dev/null); then return 0; fi
if [ "${1:-}" = "--self-test" ]; then self_test; fi
run_gate
