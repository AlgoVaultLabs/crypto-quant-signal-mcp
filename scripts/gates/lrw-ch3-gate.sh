#!/usr/bin/env bash
# lrw-ch3-gate.sh — EDGE-LABELER-RACE-WINDOW-V2-W1 CH3 (the historical -v2 relabel, the race_gap_candles
# annotation, the registered disagreement table).
#
# TWO MODES, one decision function:
#   --code-only   the precondition for landing the CH3 code (before any relabel write):
#                   1. npm run build (+ build:knowledge, as deploy.yml)
#                   2. the CH3 suites pass (relabel, extract-sql, completeness, disagreement)
#                   3. the sub-scripts' own self-tests pass (lrw-pull.sh, lrw-relabel-runner.sh)
#                   4. §3.1 of the registration in this tree is byte-equal to §3.1 AT the registration commit — the
#                      suites pin the generator to the working-tree file, this pins that file to what was registered
#                   5. the MUTATION MATRIX: an unmutated CONTROL first (every target passes on the unmutated
#                      sandbox, else INDETERMINATE), then each mutation must apply to exactly ONE place and turn its
#                      target RED by an assertion — a target that crashed or never ran is ERRORED, not killed
#                 → CH3_CODE_GREEN / CH3_RED / CH3_INDETERMINATE
#   (default)     all of the above, then the DATA legs, read after the relabel + annotation + pull + table:
#                   D1 the registration commit is an ancestor of origin/main and contains the file
#                   D2 the pull's meta: LRW_PULL_VERDICT=PASS, tokens ok, counters equal, the PINNED T_CUT, the
#                      registration committed before the pull started
#                   D3 the table: its T_CUT is the pinned one, cells_tested 0, ≥ 1 twin in the headline, and its
#                      extract is the file the pull hashed
#                   D4 every -v2 row carries race_gap_candles = 0, and -v2 rows exist (read-only)
#                   D5 the -v1 LABEL digest under T_CAP equals the one taken BEFORE the first CH3 write, on the same
#                      pinned T_CUT (ruling LRW-Q7-C — add-only, proven on the server)
#                   D6 the annotation is DONE on the rows: no NULL -v1 row the pinned worklists could annotate
#                   D7 the relabel is DONE on the rows: every signal it would still visit carries a registered
#                      manifest class (none deferred), AND every runner's own last word was CONVERGED
#                   D8 the BITGET 2h/8h `-v2` rows written before T_ADAPTER (amendment 2026-10-01, OAH-Q8) re-read
#                      now are byte-identical to the pinned snapshot the table classes them by — a closed set
#                 → CH3_GREEN / CH3_RED / CH3_INDETERMINATE
# A leg that could not READ its input is INDETERMINATE, never RED and never clean; RED is a measured violation.
#
# Verdict tokens (the contract): exit 0 GREEN · 1 RED · 3 INDETERMINATE; RED outranks INDETERMINATE.
# A committed bash script on purpose (the tool shell is zsh). --self-test drives the real decide() AND the real
# judge_data() on fixtures for every leg, and proves the tool guard fires by name.
#
# Usage: scripts/gates/lrw-ch3-gate.sh --code-only
#        scripts/gates/lrw-ch3-gate.sh --audit-dir <vault CH3 dir> --manifest <log>[,<log>…] --worklists <gz>,<gz>
#          (the audit dir holds pull/pull-meta.txt, disagreement.json, digest-before.txt + .meta, runner-summary.txt)
#        scripts/gates/lrw-ch3-gate.sh --self-test
set -uo pipefail

REQUIRED_TOOLS=(ssh node npm npx git grep sed cp mktemp cmp awk date)
REG_COMMIT='b11529bf48631a4f3ff8fe2119e6a85773646001'
REG_FILE='audits/labeler-race-window-v2-preregistration-2026-09-28.md'
HOST='root@204.168.185.24'
KEY="$HOME/.ssh/algovault_deploy"
PG_CTR='crypto-quant-signal-mcp-postgres-1'
SUITES=(tests/unit/lrw-relabel-v2.test.ts tests/unit/lrw-extract-sql.test.ts tests/unit/lrw-completeness.test.ts tests/unit/lrw-disagreement.test.ts)
MIN_MUTATIONS=50

# decide <mode> <build_rc> <suites> <subtests> <reg31> <mut_line> <data>
#   suites/subtests: passed | failed | missing   reg31: equal | differ | ind
#   mut_line: "MUTATIONS killed=<k> of=<n> errored=<e>" | "MUTATIONS control=FAIL…" | ""
#   data: "n/a" (code-only) | "ok" | "red:<legs>[ ind:<legs>]" | "ind:<legs>"
decide() {
  local mode="$1" build_rc="$2" suites="$3" subtests="$4" reg31="$5" mut="$6" data="$7" red="" ind="" k n e
  [ "$build_rc" = "0" ] || red="$red build"
  case "$suites" in passed) ;; failed) red="$red suites" ;; *) ind="$ind suites" ;; esac
  case "$subtests" in passed) ;; failed) red="$red sub-selftests" ;; *) ind="$ind sub-selftests" ;; esac
  case "$reg31" in equal) ;; differ) red="$red registration-3.1-drifted" ;; *) ind="$ind registration-3.1-unread" ;; esac
  case "$mut" in
    "MUTATIONS control=FAIL"*) ind="$ind mutations:control-failed" ;;
    "MUTATIONS killed="*" of="*" errored="*)
      k="$(printf '%s' "$mut" | sed -E 's/^MUTATIONS killed=([0-9]+) of=([0-9]+) errored=([0-9]+).*/\1/')"
      n="$(printf '%s' "$mut" | sed -E 's/^MUTATIONS killed=([0-9]+) of=([0-9]+) errored=([0-9]+).*/\2/')"
      e="$(printf '%s' "$mut" | sed -E 's/^MUTATIONS killed=([0-9]+) of=([0-9]+) errored=([0-9]+).*/\3/')"
      if [ "$n" -lt "$MIN_MUTATIONS" ]; then ind="$ind mutations:vacuous($n)"
      elif [ "$e" -gt 0 ]; then ind="$ind mutations:$e-errored"
      elif [ "$k" -ne "$n" ]; then red="$red mutations:$((n - k))-survived"; fi ;;
    *) ind="$ind mutations:no-result" ;;
  esac
  if [ "$mode" = full ]; then
    case "$data" in
      ok) ;;
      red:*) red="$red ${data#red:}" ;;
      ind:*) ind="$ind ${data#ind:}" ;;
      *) ind="$ind data:none" ;;
    esac
  fi
  local green=CH3_GREEN; [ "$mode" = code ] && green=CH3_CODE_GREEN
  if [ -n "$red" ]; then printf '[lrw-ch3-gate] RED:%s%s\n' "$red" "${ind:+ (also unverified:$ind)}" >&2; echo CH3_RED; return 1; fi
  if [ -n "$ind" ]; then printf '[lrw-ch3-gate] cannot verify:%s\n' "$ind" >&2; echo CH3_INDETERMINATE; return 3; fi
  echo "$green"; return 0
}

# judge_data — PURE: decides D1…D7 from values the collector read. Prints ok | red:<legs>[ ind:<legs>] | ind:<legs>.
#  1 d1            ok | fail | ind                       (ancestry + file at the registration commit)
#  2 meta          the pull-meta text ('' = unread)
#  3 pull_start_s  epoch of meta's pull_start ('' = unparsed)
#  4 reg_ts        committer epoch of the registration commit ('' = unread)
#  5 tcut          the pinned T_CUT as emitted by the generator
#  6 d3            "t_cut=… cells_tested=… n=… extract_sha=…" from disagreement.json ('' = unread)
#  7 d4            the read-only output: token, V2_ROWS=<n>, V2_GAP_NONZERO=<k>
#  8 before        digest-before.txt      9 bmeta  digest-before.meta      10 after  the read-only digest output
# 11 d6            the completeness line for the annotation      12 d7  … for the relabel
# 13 summary       the runner summary's state (lrw-pull.sh --summary-state)
# 14 d8            the re-read snapshot line (LRW_ADAPTER_SNAPSHOT=PASS sha256=… rows=…)   15 pin  its pinned sha256
judge_data() {
  local d1="$1" meta="$2" start_s="$3" reg_ts="$4" tcut="$5" d3="$6" d4="$7" before="$8" bmeta="$9" after="${10}" d6="${11}" d7="${12}" summary="${13}" d8="${14}" pin="${15}"
  local red="" ind="" tok='TOKEN current_user=aoe_readonly transaction_read_only=on' digest_re='^DIGEST n=[0-9]+ x0=-?[0-9]+ x1=-?[0-9]+$'
  case "$d1" in ok) ;; fail) red="$red D1:registration" ;; *) ind="$ind D1:unread" ;; esac
  local meta_extract=""
  if [ -z "$meta" ]; then ind="$ind D2:no-pull-meta"
  else
    printf '%s\n' "$meta" | grep -qx 'LRW_PULL_VERDICT=PASS' || red="$red D2:pull-not-pass"
    printf '%s\n' "$meta" | grep -q 'tokens=ok counters=equal' || red="$red D2:pull-assertions"
    printf '%s\n' "$meta" | grep -qx "t_cut=$tcut" || red="$red D2:pull-t_cut"
    if [ -z "$start_s" ] || [ -z "$reg_ts" ]; then ind="$ind D2:clock-unread"
    elif [ "$reg_ts" -ge "$start_s" ]; then red="$red D2:registration-not-before-pull"; fi
    meta_extract="$(printf '%s\n' "$meta" | sed -nE 's/^([0-9a-f]{64})  extract\.csv$/\1/p')"
  fi
  if [ -z "$d3" ]; then ind="$ind D3:no-table"
  else
    local t3 c3 n3 x3
    t3="$(printf '%s' "$d3" | sed -nE 's/.*t_cut=([^ ]*).*/\1/p')"; c3="$(printf '%s' "$d3" | sed -nE 's/.*cells_tested=([^ ]*).*/\1/p')"
    n3="$(printf '%s' "$d3" | sed -nE 's/.* n=([^ ]*).*/\1/p')"; x3="$(printf '%s' "$d3" | sed -nE 's/.*extract_sha=([^ ]*).*/\1/p')"
    [ "$t3" = "$tcut" ] || red="$red D3:table-t_cut"
    [ "$c3" = 0 ] || red="$red D3:cells_tested"
    if ! printf '%s' "$n3" | grep -qE '^[0-9]+$'; then ind="$ind D3:headline-unread"; elif [ "$n3" -lt 1 ]; then ind="$ind D3:no-twin"; fi
    if [ -z "$meta_extract" ]; then ind="$ind D3:pull-extract-sha-unread"; elif [ "$x3" != "$meta_extract" ]; then red="$red D3:table-not-on-the-pulled-extract"; fi
  fi
  local rows nz
  rows="$(printf '%s\n' "$d4" | sed -nE 's/^V2_ROWS=([0-9]+)$/\1/p')"; nz="$(printf '%s\n' "$d4" | sed -nE 's/^V2_GAP_NONZERO=([0-9]+)$/\1/p')"
  if [ "$(printf '%s\n' "$d4" | head -n 1)" != "$tok" ] || [ -z "$rows" ] || [ -z "$nz" ]; then ind="$ind D4:unread"
  elif [ "$nz" != 0 ]; then red="$red D4:v2-gap-nonzero"
  elif [ "$rows" = 0 ]; then ind="$ind D4:no-v2-row"; fi
  local aft; aft="$(printf '%s\n' "$after" | sed -n 2p)"
  if ! printf '%s' "$before" | grep -qE "$digest_re"; then ind="$ind D5:before-unread"
  elif ! printf '%s\n' "$bmeta" | grep -qx "t_cut=$tcut"; then red="$red D5:before-on-another-t_cut"
  elif [ "$(printf '%s\n' "$after" | head -n 1)" != "$tok" ] || ! printf '%s' "$aft" | grep -qE "$digest_re"; then ind="$ind D5:after-unread"
  elif [ "$aft" != "$before" ]; then red="$red D5:v1-digest-moved"; fi
  case "$d6" in LRW_ANNOTATION_COMPLETE=YES*) ;; LRW_ANNOTATION_COMPLETE=NO*) red="$red D6:annotation-not-done" ;; *) ind="$ind D6:unread" ;; esac
  case "$d7" in LRW_RELABEL_COMPLETE=YES*) ;; LRW_RELABEL_COMPLETE=NO*) red="$red D7:relabel-not-done" ;; *) ind="$ind D7:unread" ;; esac
  case "$summary" in ok) ;; fail:*) red="$red D7:${summary#fail:}" ;; *) ind="$ind D7:${summary#ind:}" ;; esac
  local sha8; sha8="$(printf '%s' "$d8" | sed -nE 's/^LRW_ADAPTER_SNAPSHOT=PASS sha256=([0-9a-f]{64}) rows=[0-9]+$/\1/p')"
  if [ -z "$sha8" ] || ! printf '%s' "$pin" | grep -qE '^[0-9a-f]{64}$'; then ind="$ind D8:unread"
  elif [ "$sha8" != "$pin" ]; then red="$red D8:pre-t_adapter-set-moved"; fi
  if [ -n "$red" ]; then echo "red:$red${ind:+ ind:$ind}"; elif [ -n "$ind" ]; then echo "ind:$ind"; else echo ok; fi
}

# The mutation table: literal text → literal text, each applied to EXACTLY one place (else ERRORED). Targets:
# vitest:<file> or sh:<command> (a self-test). Kept as data so no shell escaping can misapply a row.
mutation_table() {
  cat <<'JSON'
[
 ["R1", "src/scripts/backfill-directional-labels.ts", "vitest:tests/unit/lrw-relabel-v2.test.ts", "rows.push([x.id, v.spec,", "rows.push([x.id, v.spec.replace('-v2', '-v1'),"],
 ["R2", "src/scripts/backfill-directional-labels.ts", "vitest:tests/unit/lrw-relabel-v2.test.ts", "      if (done.has(`${x.id}|${v.spec}`)) continue;\n      const bp", "      const bp"],
 ["R3", "src/scripts/backfill-directional-labels.ts", "vitest:tests/unit/lrw-relabel-v2.test.ts", "if (prep.kind === 'refused') { manifest(x.id, `refused:${prep.reason}` as RelabelClass); continue; }", "if (prep.kind === 'refused') { continue; }"],
 ["R4", "src/scripts/backfill-directional-labels.ts", "vitest:tests/unit/lrw-relabel-v2.test.ts", "if (x.created_at >= reachCutS) return true;", "if (true) return true;"],
 ["R5", "src/scripts/backfill-directional-labels.ts", "vitest:tests/unit/lrw-relabel-v2.test.ts", "if (ctx.retired.has(g.exchange))", "if (false)"],
 ["R6", "src/scripts/backfill-directional-labels.ts", "vitest:tests/unit/lrw-relabel-v2.test.ts", "if (ownMinIntervalMs <= 0) return;", "return;"],
 ["R7", "src/scripts/backfill-directional-labels.ts", "vitest:tests/unit/lrw-relabel-v2.test.ts", "SET race_gap_candles = v.gap ", "SET race_gap_candles = v.gap, computed_at = now() "],
 ["R8", "src/scripts/backfill-directional-labels.ts", "vitest:tests/unit/lrw-relabel-v2.test.ts", "WHERE l.ctid = v.t AND l.race_gap_candles IS NULL ", "WHERE l.ctid = v.t "],
 ["R9", "src/scripts/backfill-directional-labels.ts", "vitest:tests/unit/lrw-relabel-v2.test.ts", "if (lt[0]?.v !== '5s') throw", "if (false) throw"],
 ["R10", "src/scripts/lrw/annotation-sources.ts", "vitest:tests/unit/lrw-relabel-v2.test.ts", "if (prev !== undefined && prev !== gap) throw", "if (false) throw"],
 ["R11", "src/scripts/lrw/extract-sql.ts", "vitest:tests/unit/lrw-extract-sql.test.ts", "  ORDER BY s.id, v1.barrier_spec\n", "  ORDER BY s.id\n"],
 ["R12", "src/scripts/lrw/disagreement.ts", "vitest:tests/unit/lrw-disagreement.test.ts", "if (r.lowvolV1) { a.lowvol++; return; }", "if (r.lowvolV1) { a.lowvol++; }"],
 ["R13", "src/scripts/lrw/disagreement.ts", "vitest:tests/unit/lrw-disagreement.test.ts", "if (a.twins < THIN_FLOOR)", "if (a.twins < 3)"],
 ["R14", "src/scripts/lrw/disagreement.ts", "vitest:tests/unit/lrw-disagreement.test.ts", "if (o === 'upper') up++;", "if (o === 'upper' || o === 'ambiguous') up++;"],
 ["R15", "src/scripts/lrw/disagreement.ts", "vitest:tests/unit/lrw-disagreement.test.ts", "if (used.length >= MIN_CLUSTER_DAYS)", "if (used.length >= 1)"],
 ["R16", "src/scripts/lrw/disagreement.ts", "vitest:tests/unit/lrw-disagreement.test.ts", ".map(Number).sort((p, q) => q - p)", ".map(Number).sort((p, q) => p - q)"],
 ["R17", "scripts/lrw/lrw-pull.sh", "sh:bash scripts/lrw/lrw-pull.sh --self-test", "moved) red=\"$red concurrent-writer\" ;;", "moved) ;;"],
 ["R18", "ops/label-backfill/lrw-relabel-runner.sh", "sh:LRW_RUNNER_SELFTEST=1 bash ops/label-backfill/lrw-relabel-runner.sh", "echo $((24 * 60 - now + SLOT_END_MIN))", "echo $((24 * 60 - now))"],
 ["R19", "src/scripts/lrw/disagreement.ts", "vitest:tests/unit/lrw-disagreement.test.ts", "const pooled = sel.filter((r) => ax(r).grid !== 'coarser' && !ax(r).adapterCell);", "const pooled = sel.filter((r) => !ax(r).adapterCell);"],
 ["R20", "src/scripts/lrw/disagreement.ts", "vitest:tests/unit/lrw-disagreement.test.ts", "tri(wl !== undefined, wl?.ambiguousUc === 1)", "(wl?.ambiguousUc === 1 ? 'yes' : 'no')"],
 ["R21", "src/scripts/lrw/disagreement.ts", "vitest:tests/unit/lrw-disagreement.test.ts", "    cells.push({ key: { ...base, registered_cell: name }, read: readAcc(a) });", "    if (a.registered > 0) cells.push({ key: { ...base, registered_cell: name }, read: readAcc(a) });"],
 ["R22", "src/scripts/lrw/disagreement.ts", "vitest:tests/unit/lrw-disagreement.test.ts", "=> d.v1 !== null && d.v2 !== null);", "=> d.v1 !== null);"],
 ["R23", "src/scripts/lrw/disagreement.ts", "vitest:tests/unit/lrw-disagreement.test.ts", "if (tCut !== T_CUT_EPOCH) throw", "if (false) throw"],
 ["R24", "src/scripts/lrw/disagreement.ts", "vitest:tests/unit/lrw-disagreement.test.ts", "if (sha(files[flag]) !== pin) throw", "if (false) throw"],
 ["R25", "src/scripts/lrw/disagreement.ts", "vitest:tests/unit/lrw-disagreement.test.ts", "const out: string[] = [HEADER_CLAUSE, ''];", "const out: string[] = [];"],
 ["R26", "src/scripts/lrw/relabel-sql.ts", "vitest:tests/unit/lrw-relabel-v2.test.ts", "if (until !== undefined && until > cut) throw", "if (false) throw"],
 ["R27", "src/scripts/lrw/registered.ts", "vitest:tests/unit/lrw-relabel-v2.test.ts", "export const ADAPTER_PENDING_CELLS: ReadonlySet<string> = new Set<string>([]);", "export const ADAPTER_PENDING_CELLS: ReadonlySet<string> = new Set<string>(['BITGET:2h', 'BITGET:8h']);"],
 ["R28", "src/scripts/backfill-directional-labels.ts", "vitest:tests/unit/lrw-relabel-v2.test.ts", "return ownStopArmed && (Date.now() >= ownDeadlineMs || isStopRequested());", "return false;"],
 ["R29", "src/scripts/lrw/annotation-sources.ts", "vitest:tests/unit/lrw-relabel-v2.test.ts", "if (!ANNOTATION_SOURCE_SHA256.has(sha256)) throw", "if (false) throw"],
 ["R30", "src/scripts/backfill-directional-labels.ts", "vitest:tests/unit/lrw-relabel-v2.test.ts", "if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) { a.outcome = 'global-budget'; break; }", ""],
 ["R31", "src/scripts/lrw/completeness.ts", "vitest:tests/unit/lrw-completeness.test.ts", "if (cls === undefined || cls === 'deferred') {", "if (cls === undefined) {"],
 ["R32", "src/scripts/lrw/completeness.ts", "vitest:tests/unit/lrw-completeness.test.ts", "if (lines[0] !== RO_TOKEN_LINE) throw", "if (false) throw"],
 ["R33", "scripts/lrw/lrw-pull.sh", "sh:bash scripts/lrw/lrw-pull.sh --self-test", "grep -qv ' CONVERGED$' && { echo 'fail:runner-not-converged'; return; }", "false && { echo 'fail:runner-not-converged'; return; }"],
 ["R34", "scripts/lrw/lrw-pull.sh", "sh:bash scripts/lrw/lrw-pull.sh --self-test", "WRITER_PATTERN='[b]ackfill-directional-labels|", "WRITER_PATTERN='backfill-directional-labels|"],
 ["R35", "ops/label-backfill/lrw-relabel-runner.sh", "sh:LRW_RUNNER_SELFTEST=1 bash ops/label-backfill/lrw-relabel-runner.sh", "for f in written errors budgetSkips cutShort; do", "for f in written; do"],
 ["R36", "ops/label-backfill/lrw-relabel-runner.sh", "sh:LRW_RUNNER_SELFTEST=1 bash ops/label-backfill/lrw-relabel-runner.sh", "grep -q '\"outcome\":\"stopped\"' && { echo stopped; return; }", "false && { echo stopped; return; }"],
 ["R37", "src/scripts/lrw/extract-sql.ts", "vitest:tests/unit/lrw-extract-sql.test.ts", "if (argv.includes('--t-cut')) {", "if (false) {"],
 ["R38", "src/scripts/lrw/annotation-sources.ts", "vitest:tests/unit/lrw-relabel-v2.test.ts", "    if (iId < 0 || iSpec < 0 || iGap < 0) throw", "    if (false) throw"],
 ["R39", "src/scripts/backfill-directional-labels.ts", "vitest:tests/unit/lrw-relabel-v2.test.ts", "const reachDays = ADAPTER_CELL.has(`${g.exchange}:${g.timeframe}`) ? Infinity : expiryReachDays(g.exchange, g.timeframe);", "const reachDays = expiryReachDays(g.exchange, g.timeframe);"],
 ["R40", "src/scripts/lrw/disagreement.ts", "vitest:tests/unit/lrw-disagreement.test.ts", "const pooled = sel.filter((r) => ax(r).grid !== 'coarser' && !ax(r).adapterCell);", "const pooled = sel.filter((r) => ax(r).grid !== 'coarser');"],
 ["R41", "src/scripts/lrw/disagreement.ts", "vitest:tests/unit/lrw-disagreement.test.ts", "ADAPTER_CELL.has(`${r.exchange}:${r.timeframe}`) && strata.adapterBefore.has(`${r.id}|${r.spec}`)", "false"],
 ["R42", "src/scripts/lrw/disagreement.ts", "vitest:tests/unit/lrw-disagreement.test.ts", "  if (s.adapterBefore.has(`${r.id}|${r.spec}`)) return 'unreachable:adapter-pending';\n", ""],
 ["R43", "src/scripts/lrw/completeness.ts", "vitest:tests/unit/lrw-completeness.test.ts", "AND d.computed_at < to_timestamp(${T_ADAPTER})", "AND d.computed_at <= to_timestamp(${T_ADAPTER})"],
 ["R44", "scripts/lrw/lrw-pull.sh", "sh:bash scripts/lrw/lrw-pull.sh --self-test", "if [ \"$1\" = 1 ] && [ \"$2\" = 0 ]; then echo introduces;", "if [ \"$1\" -ge 1 ]; then echo introduces;"],
 ["R45", "src/scripts/lrw/disagreement.ts", "vitest:tests/unit/lrw-disagreement.test.ts", "if (ab[0] !== 'signal_id,barrier_spec') throw", "if (false) throw"],
 ["R46", "src/scripts/backfill-directional-labels.ts", "vitest:tests/unit/lrw-relabel-v2.test.ts", "        if (unserved) {", "        if (false) {"],
 ["R47", "src/scripts/backfill-directional-labels.ts", "vitest:tests/unit/lrw-relabel-v2.test.ts", "  venueControl.set(exchange, { served, atMs: Date.now() });\n  return served;", "  venueControl.set(exchange, { served, atMs: Date.now() });\n  return true;"],
 ["R48", "src/scripts/backfill-directional-labels.ts", "vitest:tests/unit/lrw-relabel-v2.test.ts", "return code === 'UPSTREAM_RATE_LIMIT' || code === 'WEIGHT_BUDGET_SKIP';", "return code === 'WEIGHT_BUDGET_SKIP';"],
 ["R49", "ops/label-backfill/lrw-relabel-runner.sh", "sh:LRW_RUNNER_SELFTEST=1 bash ops/label-backfill/lrw-relabel-runner.sh", "watchdog_ms() { echo $(( ($1 + 10) * 60000 )); }", "watchdog_ms() { echo 21600000; }"],
 ["R50", "ops/label-backfill/lrw-relabel-runner.sh", "sh:LRW_RUNNER_SELFTEST=1 bash ops/label-backfill/lrw-relabel-runner.sh", " -e SCRIPT_WATCHDOG_MS=\"$(watchdog_ms \"$left\")\" \"$CTR\" \"$@\"", " \"$CTR\" \"$@\""]
]
JSON
}

# The matrix driver (node): sandbox per row, exact-once literal replacement, kill = an ASSERTION failed.
# Each sandbox gets the REGISTERED bytes of the registration (git show of the registration commit), not the
# working tree's. A target run is 'pass' | 'killed' (a test or self-test assertion failed) | 'errored' (it
# crashed or never ran) — only 'killed' counts as a kill. (No comments inside the heredoc: the ops-corpus
# guard reads this file as shell.)
mutation_driver() {
  cat <<'JS'
const fs = require('fs'), cp = require('child_process'), path = require('path');
const [root, tmp, tableFile, regBytes, regRel] = process.argv.slice(2);
const table = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
const box = (d) => {
  fs.mkdirSync(d, { recursive: true });
  for (const x of ['src', 'tests', 'docs', 'scripts', 'ops']) cp.execFileSync('cp', ['-R', path.join(root, x), d]);
  for (const f of ['package.json', 'tsconfig.json', 'vitest.config.ts']) fs.copyFileSync(path.join(root, f), path.join(d, f));
  fs.mkdirSync(path.join(d, path.dirname(regRel)), { recursive: true });
  fs.copyFileSync(regBytes, path.join(d, regRel));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(d, 'node_modules'));
};
const run = (d, target) => {
  if (target.startsWith('vitest:')) {
    const r = cp.spawnSync('npx', ['vitest', 'run', target.slice(7)], { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 });
    const out = `${r.stdout}\n${r.stderr}`;
    const line = (out.match(/^\s*Tests\s+.*$/m) || [''])[0];
    if (/\d+ failed/.test(line)) return 'killed';
    if (/^\s*Tests\s+\d+ passed \(\d+\)\s*$/.test(line)) return 'pass';
    return 'errored';
  }
  const r = cp.spawnSync('bash', ['-c', target.slice(3)], { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
  const out = `${r.stdout}\n${r.stderr}`;
  if (/SELFTEST: FAIL/.test(out)) return 'killed';
  if (/SELFTEST: PASS/.test(out)) return 'pass';
  return 'errored';
};
const ctl = path.join(tmp, 'box-control');
box(ctl);
for (const t of [...new Set(table.map((r) => r[2]))]) {
  const s = run(ctl, t);
  if (s !== 'pass') { console.error(`[lrw-ch3-gate] CONTROL ${s}: ${t}`); console.log(`MUTATIONS control=FAIL (${t})`); process.exit(0); }
}
fs.rmSync(ctl, { recursive: true, force: true });
console.error('[lrw-ch3-gate] control: every target passes on the unmutated sandbox');
let killed = 0, errored = 0;
for (const [name, file, target, from, to] of table) {
  const d = path.join(tmp, `box-${name}`);
  box(d);
  const f = path.join(d, file);
  const src = fs.readFileSync(f, 'utf8');
  const n = src.split(from).length - 1;
  if (n !== 1) { errored++; console.error(`[lrw-ch3-gate] mutation ${name} ERRORED: matches ${n} places`); fs.rmSync(d, { recursive: true, force: true }); continue; }
  fs.writeFileSync(f, src.replace(from, () => to));
  const s = run(d, target);
  if (s === 'killed') killed++; else if (s === 'errored') errored++;
  console.error(`[lrw-ch3-gate] mutation ${name} ${s === 'pass' ? 'SURVIVED' : s.toUpperCase()}`);
  fs.rmSync(d, { recursive: true, force: true });
}
console.log(`MUTATIONS killed=${killed} of=${table.length} errored=${errored}`);
JS
}

# §3.1 of a registration text (stdin) — from its heading to the next.
section_31() { awk '/^### 3\.1 The read session/{p=1} /^### 3\.2 The off-DB strata/{p=0} p'; }

ro_query() { # <sql…> → stdout of one READ ONLY session (token line first)
  { printf 'BEGIN READ ONLY;\n%s;\n' "$(node dist/scripts/lrw/extract-sql.js --emit TOKEN)"
    local s; for s in "$@"; do printf '%s;\n' "$s"; done
    printf 'ROLLBACK;\n'; } |
    ssh -o ConnectTimeout=20 -o ServerAliveInterval=15 -i "$KEY" "$HOST" "docker exec -i $PG_CTR psql -U aoe_readonly -d signal_performance -At -q -v ON_ERROR_STOP=1"
}

to_epoch() { date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null || date -u -d "$1" +%s 2>/dev/null; }

collect_data() { # <audit-dir> <manifest> <worklists> <tmp> → prints judge_data's result
  local dir="$1" manifest="$2" worklists="$3" tmp="$4"
  local d1=ok
  git fetch origin --quiet 2>/dev/null || d1=ind
  if [ "$d1" = ok ]; then
    git merge-base --is-ancestor "$REG_COMMIT" origin/main 2>/dev/null && git cat-file -e "$REG_COMMIT:$REG_FILE" 2>/dev/null || d1=fail
  fi
  local tcut meta="" start_s="" reg_ts d3="" d4 before="" bmeta="" after d6 d7 summary
  tcut="$(node dist/scripts/lrw/extract-sql.js --emit T_CUT 2>/dev/null)"
  reg_ts="$(git log -1 --format=%ct "$REG_COMMIT" 2>/dev/null)"
  if [ -r "$dir/pull/pull-meta.txt" ]; then
    meta="$(cat "$dir/pull/pull-meta.txt" 2>/dev/null)"
    start_s="$(to_epoch "$(printf '%s\n' "$meta" | sed -n 's/^pull_start=//p')")"
  fi
  [ -r "$dir/disagreement.json" ] && d3="$(node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const m = j.meta || {};
    console.log(`t_cut=${m.t_cut} cells_tested=${m.cells_tested} n=${j.headline && j.headline.n} extract_sha=${m.inputs && m.inputs.extract && m.inputs.extract.sha256}`);
  ' "$dir/disagreement.json" 2>/dev/null)"
  d4="$(ro_query "SELECT 'V2_ROWS=' || count(*) FROM directional_labels WHERE barrier_spec LIKE '%-v2'" \
    "SELECT 'V2_GAP_NONZERO=' || count(*) FROM directional_labels WHERE barrier_spec LIKE '%-v2' AND race_gap_candles IS DISTINCT FROM 0" 2>/dev/null)"
  [ -r "$dir/digest-before.txt" ] && before="$(cat "$dir/digest-before.txt" 2>/dev/null)"
  [ -r "$dir/digest-before.meta" ] && bmeta="$(cat "$dir/digest-before.meta" 2>/dev/null)"
  after="$(ro_query "$(node dist/scripts/lrw/extract-sql.js --emit V1_DIGEST)" 2>/dev/null)"
  d6=""; d7=""
  if ro_query "$(node dist/scripts/lrw/completeness.js --emit NULL_V1_GAP)" > "$tmp/null-v1-gap.txt" 2>/dev/null; then
    d6="$(node dist/scripts/lrw/completeness.js --annotation --null-keys "$tmp/null-v1-gap.txt" --worklists "$worklists" 2>/dev/null)"
  fi
  if ro_query "$(node dist/scripts/lrw/completeness.js --emit MISSING_V2)" > "$tmp/missing-v2.txt" 2>/dev/null; then
    d7="$(node dist/scripts/lrw/completeness.js --relabel --missing "$tmp/missing-v2.txt" --manifest "$manifest" 2>/dev/null)"
  fi
  summary="$(bash scripts/lrw/lrw-pull.sh --summary-state "$dir/runner-summary.txt" 2>/dev/null)"
  local d8="" pin8
  if ro_query "$(node dist/scripts/lrw/completeness.js --emit ADAPTER_V2_BEFORE)" > "$tmp/adapter-v2-before.txt" 2>/dev/null; then
    d8="$(node dist/scripts/lrw/completeness.js --adapter-snapshot --session "$tmp/adapter-v2-before.txt" --out "$tmp/adapter-v2-before.csv" 2>/dev/null)"
  fi
  pin8="$(node -e "console.log(require('./dist/scripts/lrw/registered.js').PINNED_SHA256.adapterBefore)" 2>/dev/null)"
  printf '[lrw-ch3-gate] D6: %s\n[lrw-ch3-gate] D7: %s\n[lrw-ch3-gate] D8: %s\n' "${d6:-unread}" "${d7:-unread}" "${d8:-unread}" >&2
  judge_data "$d1" "$meta" "$start_s" "$reg_ts" "$tcut" "$d3" "$d4" "$before" "$bmeta" "$after" "$d6" "$d7" "${summary:-ind:unread}" "$d8" "$pin8"
}

run_gate() {
  local mode=full audit="" manifest="" worklists=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --code-only) mode=code; shift; continue ;;
    esac
    [ $# -ge 2 ] || { echo "[lrw-ch3-gate] $1 needs a value" >&2; echo CH3_INDETERMINATE; exit 3; }
    case "$1" in
      --audit-dir) audit="$2" ;;
      --manifest) manifest="$2" ;;
      --worklists) worklists="$2" ;;
      *) echo "[lrw-ch3-gate] unknown argument $1" >&2; echo CH3_INDETERMINATE; exit 3 ;;
    esac
    shift 2
  done
  local t
  for t in "${REQUIRED_TOOLS[@]}"; do
    command -v "$t" >/dev/null 2>&1 || { printf "[lrw-ch3-gate] required tool '%s' not on PATH\n" "$t" >&2; echo CH3_INDETERMINATE; exit 3; }
  done
  local root; root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo CH3_INDETERMINATE; exit 3; }
  cd "$root" || { echo CH3_INDETERMINATE; exit 3; }
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/lrw-ch3-gate.XXXXXX")" || { echo CH3_INDETERMINATE; exit 3; }
  { npm run build && npm run build:knowledge; } >"$tmp/build.log" 2>&1
  local build_rc=$? suites=missing subtests=missing reg31=ind mut="" data="n/a"
  if git show "$REG_COMMIT:$REG_FILE" > "$tmp/registered.md" 2>/dev/null && [ -s "$tmp/registered.md" ] && [ -r "$REG_FILE" ]; then
    local s_reg s_tree; s_reg="$(section_31 < "$tmp/registered.md")"; s_tree="$(section_31 < "$REG_FILE")"
    if [ -z "$s_reg" ]; then reg31=ind; elif [ "$s_reg" = "$s_tree" ]; then reg31=equal; else reg31=differ; fi
  fi
  if [ "$build_rc" -eq 0 ]; then
    if npx vitest run "${SUITES[@]}" </dev/null >"$tmp/suites.log" 2>&1 && grep -qE '^ +Tests +[0-9]+ passed \(' "$tmp/suites.log"; then suites=passed; else suites=failed; fi
    if bash scripts/lrw/lrw-pull.sh --self-test >"$tmp/sub.log" 2>&1 && LRW_RUNNER_SELFTEST=1 bash ops/label-backfill/lrw-relabel-runner.sh >>"$tmp/sub.log" 2>&1; then subtests=passed; else subtests=failed; fi
    if [ "$reg31" = equal ]; then
      mutation_table > "$tmp/mutations.json"; mutation_driver > "$tmp/driver.js"
      mut="$(node "$tmp/driver.js" "$root" "$tmp" "$tmp/mutations.json" "$tmp/registered.md" "$REG_FILE")"
    fi
    if [ "$mode" = full ]; then
      if [ -n "$audit" ] && [ -n "$manifest" ] && [ -n "$worklists" ]; then data="$(collect_data "$audit" "$manifest" "$worklists" "$tmp")"; else data="ind: data:args"; fi
    fi
  fi
  printf '[lrw-ch3-gate] mode=%s build_rc=%s suites=%s subtests=%s registration-3.1=%s\n[lrw-ch3-gate] %s\n[lrw-ch3-gate] data=%s\n' \
    "$mode" "$build_rc" "$suites" "$subtests" "$reg31" "${mut:-no mutation line}" "$data" >&2
  local rc; decide "$mode" "$build_rc" "$suites" "$subtests" "$reg31" "$mut" "$data"; rc=$?
  if [ "$rc" -eq 0 ]; then rm -rf "$tmp"; else printf '[lrw-ch3-gate] evidence kept: %s\n' "$tmp" >&2; fi
  exit "$rc"
}

self_test() {
  local pass=0 fail=0
  ok_() { pass=$((pass + 1)); echo "SELF-TEST: ok $1"; }
  no_() { fail=$((fail + 1)); echo "SELF-TEST: FAIL $1"; }
  ck() {
    local name="$1" want="$2" want_rc="$3"; shift 3
    local out rc; out="$(decide "$@" 2>/dev/null)"; rc=$?
    if [ "$out" = "$want" ] && [ "$rc" -eq "$want_rc" ]; then ok_ "$name"; else no_ "$name (got '$out' rc=$rc)"; fi
  }
  local K='MUTATIONS killed=50 of=50 errored=0'
  ck code-green CH3_CODE_GREEN 0 code 0 passed passed equal "$K" n/a
  ck full-green CH3_GREEN 0 full 0 passed passed equal "$K" ok
  ck build-red CH3_RED 1 code 2 missing missing ind "" n/a
  ck suites-red CH3_RED 1 code 0 failed passed equal "$K" n/a
  ck subtests-red CH3_RED 1 code 0 passed failed equal "$K" n/a
  ck registration-drift-red CH3_RED 1 code 0 passed passed differ "$K" n/a
  ck registration-unread-ind CH3_INDETERMINATE 3 code 0 passed passed ind "$K" n/a
  ck survivor-red CH3_RED 1 code 0 passed passed equal 'MUTATIONS killed=49 of=50 errored=0' n/a
  ck errored-ind CH3_INDETERMINATE 3 code 0 passed passed equal 'MUTATIONS killed=49 of=50 errored=1' n/a
  ck short-matrix-ind CH3_INDETERMINATE 3 code 0 passed passed equal 'MUTATIONS killed=5 of=5 errored=0' n/a
  ck control-failed-ind CH3_INDETERMINATE 3 code 0 passed passed equal 'MUTATIONS control=FAIL (x)' n/a
  ck data-red CH3_RED 1 full 0 passed passed equal "$K" 'red: D5:v1-digest-moved'
  ck data-ind CH3_INDETERMINATE 3 full 0 passed passed equal "$K" 'ind: D2:no-pull-meta'
  ck code-mode-ignores-data CH3_CODE_GREEN 0 code 0 passed passed equal "$K" 'red: D5:v1-digest-moved'
  ck red-outranks-ind CH3_RED 1 full 0 failed missing equal "" 'ind: x'

  # judge_data on fixtures — one clean world, then each leg broken ONE way at a time
  local TOK='TOKEN current_user=aoe_readonly transaction_read_only=on' TC='1790754894.743475'
  local X='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  local META; META="$(printf 'pull_start=2026-10-05T19:00:00Z\nt_cut=%s\npreconditions=ok tokens=ok counters=equal files=ok\n%s  extract.csv\nLRW_PULL_VERDICT=PASS' "$TC" "$X")"
  local D3="t_cut=$TC cells_tested=0 n=1234 extract_sha=$X" D4; D4="$(printf '%s\nV2_ROWS=10\nV2_GAP_NONZERO=0' "$TOK")"
  local DG='DIGEST n=5 x0=-12 x1=34' AFT; AFT="$(printf '%s\nDIGEST n=5 x0=-12 x1=34' "$TOK")"
  local BM="t_cut=$TC" Y6='LRW_ANNOTATION_COMPLETE=YES {}' Y7='LRW_RELABEL_COMPLETE=YES {}'
  local PIN='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' D8; D8="LRW_ADAPTER_SNAPSHOT=PASS sha256=$PIN rows=3"
  jd() { # <name> <want prefix> <args…>
    local name="$1" want="$2"; shift 2
    local got; got="$(judge_data "$@")"
    case "$got" in "$want"*) ok_ "judge-$name" ;; *) no_ "judge-$name (got '$got')" ;; esac
  }
  jd clean ok ok "$META" 1791000000 1790000000 "$TC" "$D3" "$D4" "$DG" "$BM" "$AFT" "$Y6" "$Y7" ok "$D8" "$PIN"
  jd d1-fail 'red: D1:registration' fail "$META" 1791000000 1790000000 "$TC" "$D3" "$D4" "$DG" "$BM" "$AFT" "$Y6" "$Y7" ok "$D8" "$PIN"
  jd d2-not-pass 'red: D2:pull-not-pass' ok "${META/PASS/FAIL}" 1791000000 1790000000 "$TC" "$D3" "$D4" "$DG" "$BM" "$AFT" "$Y6" "$Y7" ok "$D8" "$PIN"
  jd d2-tcut 'red: D2:pull-t_cut' ok "${META/t_cut=$TC/t_cut=1790754894}" 1791000000 1790000000 "$TC" "$D3" "$D4" "$DG" "$BM" "$AFT" "$Y6" "$Y7" ok "$D8" "$PIN"
  jd d2-order 'red: D2:registration-not-before-pull' ok "$META" 1789000000 1790000000 "$TC" "$D3" "$D4" "$DG" "$BM" "$AFT" "$Y6" "$Y7" ok "$D8" "$PIN"
  jd d2-clock 'ind: D2:clock-unread' ok "$META" '' 1790000000 "$TC" "$D3" "$D4" "$DG" "$BM" "$AFT" "$Y6" "$Y7" ok "$D8" "$PIN"
  jd d2-absent 'ind: D2:no-pull-meta' ok '' 1791000000 1790000000 "$TC" "$D3" "$D4" "$DG" "$BM" "$AFT" "$Y6" "$Y7" ok "$D8" "$PIN"
  jd d3-tcut 'red: D3:table-t_cut' ok "$META" 1791000000 1790000000 "$TC" "${D3/t_cut=$TC/t_cut=1}" "$D4" "$DG" "$BM" "$AFT" "$Y6" "$Y7" ok "$D8" "$PIN"
  jd d3-no-twin 'ind: D3:no-twin' ok "$META" 1791000000 1790000000 "$TC" "${D3/n=1234/n=0}" "$D4" "$DG" "$BM" "$AFT" "$Y6" "$Y7" ok "$D8" "$PIN"
  jd d3-other-extract 'red: D3:table-not-on-the-pulled-extract' ok "$META" 1791000000 1790000000 "$TC" "${D3/extract_sha=$X/extract_sha=b}" "$D4" "$DG" "$BM" "$AFT" "$Y6" "$Y7" ok "$D8" "$PIN"
  jd d4-gap 'red: D4:v2-gap-nonzero' ok "$META" 1791000000 1790000000 "$TC" "$D3" "${D4/NONZERO=0/NONZERO=3}" "$DG" "$BM" "$AFT" "$Y6" "$Y7" ok "$D8" "$PIN"
  jd d4-empty 'ind: D4:no-v2-row' ok "$META" 1791000000 1790000000 "$TC" "$D3" "${D4/V2_ROWS=10/V2_ROWS=0}" "$DG" "$BM" "$AFT" "$Y6" "$Y7" ok "$D8" "$PIN"
  jd d4-unread 'ind: D4:unread' ok "$META" 1791000000 1790000000 "$TC" "$D3" "$TOK" "$DG" "$BM" "$AFT" "$Y6" "$Y7" ok "$D8" "$PIN"
  jd d5-moved 'red: D5:v1-digest-moved' ok "$META" 1791000000 1790000000 "$TC" "$D3" "$D4" "$DG" "$BM" "${AFT/x1=34/x1=35}" "$Y6" "$Y7" ok "$D8" "$PIN"
  jd d5-after-unread 'ind: D5:after-unread' ok "$META" 1791000000 1790000000 "$TC" "$D3" "$D4" "$DG" "$BM" "$TOK" "$Y6" "$Y7" ok "$D8" "$PIN"
  jd d5-before-unread 'ind: D5:before-unread' ok "$META" 1791000000 1790000000 "$TC" "$D3" "$D4" '' "$BM" "$AFT" "$Y6" "$Y7" ok "$D8" "$PIN"
  jd d5-other-tcut 'red: D5:before-on-another-t_cut' ok "$META" 1791000000 1790000000 "$TC" "$D3" "$D4" "$DG" 't_cut=1790754894' "$AFT" "$Y6" "$Y7" ok "$D8" "$PIN"
  jd d6-no 'red: D6:annotation-not-done' ok "$META" 1791000000 1790000000 "$TC" "$D3" "$D4" "$DG" "$BM" "$AFT" 'LRW_ANNOTATION_COMPLETE=NO {}' "$Y7" ok "$D8" "$PIN"
  jd d6-unread 'ind: D6:unread' ok "$META" 1791000000 1790000000 "$TC" "$D3" "$D4" "$DG" "$BM" "$AFT" 'LRW_ANNOTATION_COMPLETE=INDETERMINATE x' "$Y7" ok "$D8" "$PIN"
  jd d7-no 'red: D7:relabel-not-done' ok "$META" 1791000000 1790000000 "$TC" "$D3" "$D4" "$DG" "$BM" "$AFT" "$Y6" 'LRW_RELABEL_COMPLETE=NO {}' ok "$D8" "$PIN"
  jd d7-runner 'red: D7:runner-not-converged' ok "$META" 1791000000 1790000000 "$TC" "$D3" "$D4" "$DG" "$BM" "$AFT" "$Y6" "$Y7" 'fail:runner-not-converged' "$D8" "$PIN"
  jd d7-summary-unread 'ind: D7:runner-summary-unreadable' ok "$META" 1791000000 1790000000 "$TC" "$D3" "$D4" "$DG" "$BM" "$AFT" "$Y6" "$Y7" 'ind:runner-summary-unreadable' "$D8" "$PIN"
  jd d8-moved 'red: D8:pre-t_adapter-set-moved' ok "$META" 1791000000 1790000000 "$TC" "$D3" "$D4" "$DG" "$BM" "$AFT" "$Y6" "$Y7" ok "${D8/sha256=$PIN/sha256=$X}" "$PIN"
  jd d8-unread 'ind: D8:unread' ok "$META" 1791000000 1790000000 "$TC" "$D3" "$D4" "$DG" "$BM" "$AFT" "$Y6" "$Y7" ok 'LRW_ADAPTER_SNAPSHOT=INDETERMINATE x' "$PIN"

  # the tool guard fires BY NAME: every required tool but ssh on PATH → INDETERMINATE naming ssh
  local tmp t out rc; tmp="$(mktemp -d)"
  for t in bash "${REQUIRED_TOOLS[@]}"; do [ "$t" = ssh ] || ln -s "$(command -v "$t")" "$tmp/$t" 2>/dev/null; done
  out="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" --code-only 2>&1)"; rc=$?
  if [ "$(printf '%s\n' "$out" | tail -n 1)" = CH3_INDETERMINATE ] && [ "$rc" -eq 3 ] && printf '%s' "$out" | grep -q "required tool 'ssh' not on PATH"; then ok_ missing-tool-named
  else no_ "missing-tool-named (rc=$rc)"; fi
  # a value-taking flag with no value ends with a token, never a loop
  out="$(bash "${BASH_SOURCE[0]}" --audit-dir 2>/dev/null)"; rc=$?
  if [ "$out" = CH3_INDETERMINATE ] && [ "$rc" -eq 3 ]; then ok_ missing-value; else no_ "missing-value (got '$out' rc=$rc)"; fi
  rm -rf "$tmp"
  if [ "$fail" -eq 0 ] && [ "$pass" -ge 41 ]; then echo "LRW_CH3_GATE_SELFTEST: PASS ($pass checks)"; exit 0; fi
  echo "LRW_CH3_GATE_SELFTEST: FAIL ($fail of $((pass + fail)))"; exit 1
}

if (return 0 2>/dev/null); then return 0; fi
if [ "${1:-}" = "--self-test" ]; then self_test; fi
run_gate "$@"
