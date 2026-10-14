#!/usr/bin/env bash
# lrw-ch4-gate.sh — EDGE-LABELER-RACE-WINDOW-V2-W1 CH4: the -v1 consumer registry, the -v1 deprecation, the
# race-integrity canary (rulings Q-A = A, Q-B = B).
#
# TWO MODES, one decision function:
#   --code-only   before the canary is installed:
#                   L1 the CH4 suites pass (the registry, the canary's seal allow-list + self-test, the producer's
#                      counter + live recount, the caller-tag site pin)
#                   L2 the canary's own self-test passes on the Mac
#                   L6 rider 3: the labeler envelope's added `counts` key is accepted by BOTH validators (Python on
#                      signal-1, the deployed TS) and the freshness consumer is byte-unchanged over every recorded
#                      capacity envelope (validate / decide / render_body, with vs without the key)
#                   L7 the MUTATION MATRIX: an unmutated CONTROL first, then each mutation applied to exactly ONE place
#                      must turn its target RED by an assertion (a crash or a non-run is ERRORED, never a kill) —
#                      including `label` added to the canary's SELECT and the producer's counter not incremented
#                 → CH4_CODE_GREEN / CH4_RED / CH4_INDETERMINATE
#   (default)     all of the above, then the install legs:
#                   L3 on signal-1, AS CRON INVOKES IT: the installed canary's self-test, then the crontab's own command
#                      line under ALGOVAULT_TG_TEST_INERT=1 with positive per-check output and a verdict token
#                   L4 the canary's commit also carries its inventory row, its alert-registry row and the registry
#                   L5 monitoring-results-sync.sh PASS, and the vault canary-results.jsonl holds the canary's line
#                 → CH4_GREEN / CH4_RED / CH4_INDETERMINATE
# A leg that could not READ its input is INDETERMINATE, never RED and never clean; RED is a measured violation.
# Verdict tokens (the contract): exit 0 GREEN · 1 RED · 3 INDETERMINATE; RED outranks INDETERMINATE.
# A committed bash script on purpose (the tool shell is zsh). --self-test drives the real decide() with a synthetic
# FAIL, a missing token and a missing tool.
#
# Usage: scripts/gates/lrw-ch4-gate.sh --code-only | (no flag) | --self-test
set -uo pipefail

REQUIRED_TOOLS=(ssh node npx git python3 grep sed cp mktemp awk)
HOST='root@204.168.185.24'
KEY="$HOME/.ssh/algovault_deploy"
APP_CTR='crypto-quant-signal-mcp-mcp-server-1'
CANARY='ops/monitoring/directional-labels-race-integrity.py'
CANARY_ID='directional-labels-race-integrity'
HOST_CANARY='/opt/algovault-monitoring/directional-labels-race-integrity.py'
VAULT_RESULTS="${LRW_VAULT_RESULTS:-$HOME/My Drive/Obsidian Vault/AlgoVault MCP/Claude files/canary-results.jsonl}"
SUITES=(tests/unit/directional-labels-consumers.test.ts tests/unit/directional-labels-race-integrity.test.ts tests/unit/lrw-race-window-v2.test.ts tests/unit/caller-tags.test.ts)
MIN_MUTATIONS=12

# decide <mode> <suites> <selftest> <rider3> <mut_line> <install>
#   suites/selftest: passed | failed | missing   rider3: ok | red:<why> | ind:<why>
#   mut_line: "MUTATIONS killed=<k> of=<n> errored=<e>" | "MUTATIONS control=FAIL…" | ""
#   install: "n/a" (code-only) | "ok" | "red:<legs>[ ind:<legs>]" | "ind:<legs>"
decide() {
  local mode="$1" suites="$2" selftest="$3" rider3="$4" mut="$5" install="$6" red="" ind="" k n e
  case "$suites" in passed) ;; failed) red="$red suites" ;; *) ind="$ind suites" ;; esac
  case "$selftest" in passed) ;; failed) red="$red canary-selftest" ;; *) ind="$ind canary-selftest" ;; esac
  case "$rider3" in ok) ;; red:*) red="$red rider3(${rider3#red:})" ;; *) ind="$ind rider3(${rider3#ind:})" ;; esac
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
    case "$install" in ok) ;; red:*) red="$red ${install#red:}" ;; ind:*) ind="$ind ${install#ind:}" ;; *) ind="$ind install:none" ;; esac
  fi
  local green=CH4_GREEN; [ "$mode" = code ] && green=CH4_CODE_GREEN
  if [ -n "$red" ]; then printf '[lrw-ch4-gate] RED:%s\n' "$red" >&2; echo 'CH4_RED'; return 1; fi
  if [ -n "$ind" ]; then printf '[lrw-ch4-gate] cannot verify:%s\n' "$ind" >&2; echo 'CH4_INDETERMINATE'; return 3; fi
  echo "$green"; return 0
}

# The mutation table: literal text → literal text, each applied to EXACTLY one place (else ERRORED).
# Targets: vitest:<file> or sh:<command> (a self-test). Kept as data so no shell escaping can misapply a row.
mutation_table() {
  cat <<'JSON'
[
 ["M1", "ops/monitoring/directional-labels-race-integrity.py", "vitest:tests/unit/directional-labels-race-integrity.test.ts", "\"SELECT signal_id, min(race_gap_candles), max(race_gap_candles) FROM directional_labels \"", "\"SELECT signal_id, label, min(race_gap_candles), max(race_gap_candles) FROM directional_labels \""],
 ["M2", "src/scripts/backfill-directional-labels.ts", "vitest:tests/unit/lrw-race-window-v2.test.ts", "    if (prep.kind !== 'ready' && !wroteV1) cov.v1CutUnwritable++; // not raced below, and its -v1 attempt wrote no row\n", ""],
 ["M3", "src/scripts/backfill-directional-labels.ts", "vitest:tests/unit/lrw-race-window-v2.test.ts", "  const v1View = withinExtents([...cache.values()].sort((a, b) => a.time - b.time), [extent]);", "  const v1View = [...cache.values()].sort((a, b) => a.time - b.time);"],
 ["M4", "ops/monitoring/directional-labels-race-integrity.py", "sh:python3 -B ops/monitoring/directional-labels-race-integrity.py --self-test", "checks[\"identity\"] = (PASS if residual == 0 else FAIL,", "checks[\"identity\"] = (PASS if residual <= 0 else FAIL,"],
 ["M5", "ops/monitoring/directional-labels-race-integrity.py", "sh:python3 -B ops/monitoring/directional-labels-race-integrity.py --self-test", "    if len(set(by_spec.values())) > 1:", "    if False:"],
 ["M6", "ops/monitoring/directional-labels-race-integrity.py", "sh:python3 -B ops/monitoring/directional-labels-race-integrity.py --self-test", "checks[\"v2_gap_zero\"] = (PASS if gap_nz == 0 else FAIL,", "checks[\"v2_gap_zero\"] = (PASS,"],
 ["M7", "ops/monitoring/directional-labels-race-integrity.py", "sh:python3 -B ops/monitoring/directional-labels-race-integrity.py --self-test", "        unequal = [f\"{sid}:{stored}->{live}\" for sid, stored, live in compared if stored != live]", "        unequal = []"],
 ["M8", "ops/monitoring/directional-labels-race-integrity.py", "sh:python3 -B ops/monitoring/directional-labels-race-integrity.py --self-test", "    report_only = len(st[\"counter_runs\"]) <= ARMING_REPORT_ONLY_RUNS", "    report_only = False"],
 ["M9", "ops/monitoring/directional-labels-race-integrity.py", "sh:python3 -B ops/monitoring/directional-labels-race-integrity.py --self-test", "    page = verdict == FAIL and not report_only", "    page = verdict != PASS and not report_only"],
 ["M10", "ops/monitoring/directional-labels-race-integrity.py", "sh:python3 -B ops/monitoring/directional-labels-race-integrity.py --self-test", "    elif isinstance(done.get(\"budgetSkips\"), int) and done[\"budgetSkips\"] > 0:", "    elif False:"],
 ["M11", "ops/monitoring/directional-labels-race-integrity.py", "sh:python3 -B ops/monitoring/directional-labels-race-integrity.py --self-test", "    elif not isinstance(done.get(CUT_FIELD), int):", "    elif False:"],
 ["M12", "ops/monitoring/directional-labels-consumers.json", "vitest:tests/unit/directional-labels-consumers.test.ts", "\"path\": \"docs/Directional-Accuracy-SoT.md\"", "\"path\": \"docs/Directional-Accuracy-SoT.mdX\""],
 ["M13", "docs/Directional-Accuracy-SoT.md", "vitest:tests/unit/directional-labels-consumers.test.ts", "| Consumer | Pins | Owner | Migration wave | Status |", "| Consumer | Pins | Owner | Wave | Status |"],
 ["M14", "ops/monitoring/directional-labels-race-integrity.py", "vitest:tests/unit/directional-labels-race-integrity.test.ts", "\"v1_rows\": f\"SELECT count(*) FROM directional_labels WHERE", "\"v1_rows\": f\"SELECT count(*) FROM directional_labels d JOIN signals s ON s.id = d.signal_id WHERE"]
]
JSON
}

# The matrix driver (node), as lrw-ch3-gate.sh's: sandbox per row, exact-once literal replacement, kill = an
# ASSERTION failed. The sandbox also copies audits/ and migrations/: the registry test enumerates -v1 literals
# there too, so a sandbox without them would read every such row as stale. (No comments inside the heredoc.)
mutation_driver() {
  cat <<'JS'
const fs = require('fs'), cp = require('child_process'), path = require('path');
const [root, tmp, tableFile] = process.argv.slice(2);
const table = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
const box = (d) => {
  fs.mkdirSync(d, { recursive: true });
  for (const x of ['src', 'tests', 'docs', 'scripts', 'ops', 'audits', 'migrations']) cp.execFileSync('cp', ['-R', path.join(root, x), d]);
  for (const f of ['package.json', 'tsconfig.json', 'vitest.config.ts']) fs.copyFileSync(path.join(root, f), path.join(d, f));
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
  if (s !== 'pass') { console.error(`[lrw-ch4-gate] CONTROL ${s}: ${t}`); console.log(`MUTATIONS control=FAIL (${t})`); process.exit(0); }
}
fs.rmSync(ctl, { recursive: true, force: true });
console.error('[lrw-ch4-gate] control: every target passes on the unmutated sandbox');
let killed = 0, errored = 0;
for (const [name, file, target, from, to] of table) {
  const d = path.join(tmp, `box-${name}`);
  box(d);
  const f = path.join(d, file);
  const src = fs.readFileSync(f, 'utf8');
  const n = src.split(from).length - 1;
  if (n !== 1) { errored++; console.error(`[lrw-ch4-gate] mutation ${name} ERRORED: matches ${n} places`); fs.rmSync(d, { recursive: true, force: true }); continue; }
  fs.writeFileSync(f, src.replace(from, () => to));
  const s = run(d, target);
  if (s === 'killed') killed++; else if (s === 'errored') errored++;
  console.error(`[lrw-ch4-gate] mutation ${name} ${s === 'pass' ? 'SURVIVED' : s.toUpperCase()}`);
  fs.rmSync(d, { recursive: true, force: true });
}
console.log(`MUTATIONS killed=${killed} of=${table.length} errored=${errored}`);
JS
}

# Rider 3 (ruling Q-B): both validators accept the labeler envelope's `counts`, and the freshness consumer's
# validate / decide / render_body are byte-identical with and without it over every recorded capacity envelope.
rider3() {
  local py ts
  py="$(ssh -o ConnectTimeout=20 -i "$KEY" "$HOST" 'cd /opt/algovault-monitoring && python3 -B -' <<'PY' 2>/dev/null
import json, sys, datetime
sys.path.insert(0, "/opt/algovault-monitoring")
import detector_envelope as de
schema = de.load_schema()
lines = [l for l in open("/var/log/carry-labeler.log", encoding="utf-8", errors="replace") if "[detector-envelope] {" in l]
n = same = errs = 0
def view(env):
    e = de.validate(env, schema)
    try:
        now = datetime.datetime.fromisoformat(env.get("produced_at", "").replace("Z", "+00:00")) + datetime.timedelta(hours=1)
    except Exception:
        now = None
    return json.dumps({"e": e, "d": repr(de.decide(env, env.get("run_id"), now, schema)) if not e else None,
                       "b": de.render_body(env, schema) if not e else ""}, sort_keys=True)
for l in lines:
    env = json.loads(l.split("[detector-envelope]", 1)[1].strip())
    orig = {k: v for k, v in env.items() if k != "counts"}
    inj = dict(orig, counts={"v1CutUnwritable": 7})
    n += 1; same += view(orig) == view(inj); errs += len(de.validate(inj, schema))
print("RIDER3_PY envelopes=%d identical=%d injected_errors=%d" % (n, same, errs))
PY
)" || true
  ts="$(ssh -o ConnectTimeout=20 -i "$KEY" "$HOST" 'bash -s' <<'SH' 2>/dev/null | grep '^RIDER3_TS'
grep '\[detector-envelope\] {' /var/log/carry-labeler.log | sed 's/.*\[detector-envelope\] //' > /tmp/lrw-ch4-r3.jsonl
docker exec -i crypto-quant-signal-mcp-mcp-server-1 node -e '
const { validateEnvelope } = require("/app/dist/lib/detector-envelope.js");
let b = ""; process.stdin.on("data", (d) => (b += d)); process.stdin.on("end", () => {
  const es = b.trim().split("\n").map((l) => JSON.parse(l)); let e = 0;
  for (const x of es) e += validateEnvelope({ ...x, counts: { v1CutUnwritable: 7 } }).length;
  console.log("RIDER3_TS envelopes=" + es.length + " injected_errors=" + e);
});' < /tmp/lrw-ch4-r3.jsonl
rm -f /tmp/lrw-ch4-r3.jsonl
SH
)" || true
  printf '%s\n%s\n' "$py" "$ts" >&2
  local n same pe te tn
  n="$(printf '%s' "$py" | sed -nE 's/^RIDER3_PY envelopes=([0-9]+) .*/\1/p')"
  same="$(printf '%s' "$py" | sed -nE 's/.* identical=([0-9]+) .*/\1/p')"
  pe="$(printf '%s' "$py" | sed -nE 's/.* injected_errors=([0-9]+)$/\1/p')"
  tn="$(printf '%s' "$ts" | sed -nE 's/^RIDER3_TS envelopes=([0-9]+) .*/\1/p')"
  te="$(printf '%s' "$ts" | sed -nE 's/.* injected_errors=([0-9]+)$/\1/p')"
  if [ -z "$n" ] || [ -z "$tn" ]; then echo 'ind:unread'; return; fi
  if [ "$n" -eq 0 ]; then echo 'ind:no-recorded-envelope'; return; fi
  if [ "$same" != "$n" ]; then echo "red:freshness-consumer-changed($same/$n)"; return; fi
  if [ "$pe" != 0 ] || [ "$te" != 0 ]; then echo "red:validator-refused(py=$pe,ts=$te)"; return; fi
  echo ok
}

install_legs() { # → ok | red:<legs> | ind:<legs>
  local red="" ind="" out line sha files
  # L3 — installed self-test, then the crontab's own command line, inert
  out="$(ssh -o ConnectTimeout=20 -i "$KEY" "$HOST" "python3 -B $HOST_CANARY --self-test 2>&1 | tail -1" 2>/dev/null)" || out=""
  case "$out" in *"SELFTEST: PASS"*) ;; *"SELFTEST: FAIL"*) red="$red L3:host-selftest" ;; *) ind="$ind L3:host-selftest-unread" ;; esac
  line="$(ssh -o ConnectTimeout=20 -i "$KEY" "$HOST" "crontab -l 2>/dev/null | grep -F '$HOST_CANARY' | grep -v '^#' | head -1" 2>/dev/null)" || line=""
  if [ -z "$line" ]; then ind="$ind L3:no-cron-line"
  else
    local cmd; cmd="$(printf '%s' "$line" | awk '{ $1=$2=$3=$4=$5=""; sub(/^ +/, ""); print }' | sed -E 's/ *>>.*$//')"
    out="$(ssh -o ConnectTimeout=20 -i "$KEY" "$HOST" "ALGOVAULT_TG_TEST_INERT=1 $cmd" 2>&1)" || true
    printf '%s\n' "$out" | grep -E '^\[race-integrity\] (CHECK|COUNTS|PAGING|RESULT_LOG)|_VERDICT=' >&2
    if ! printf '%s\n' "$out" | grep -qE '^DIRECTIONAL_LABELS_RACE_INTEGRITY_VERDICT=(PASS|FAIL|INDETERMINATE)$'; then ind="$ind L3:no-verdict-token"
    elif [ "$(printf '%s\n' "$out" | grep -cE '^\[race-integrity\] CHECK ')" -lt 1 ]; then ind="$ind L3:no-per-check-output"; fi
  fi
  # L4 — the canary's commit carries its inventory row, its alert-registry row and the registry
  sha="$(git log --diff-filter=A --format=%H -- "$CANARY" | tail -1)"
  if [ -z "$sha" ]; then ind="$ind L4:canary-commit-unread"
  else
    files="$(git show --name-only --format= "$sha")"
    for f in ops/monitoring/monitoring-inventory.json ops/monitoring/alert-registry.json ops/monitoring/directional-labels-consumers.json; do
      printf '%s\n' "$files" | grep -qxF "$f" || red="$red L4:$f-not-in-${sha:0:8}"
    done
  fi
  # L5 — the results sync pulls the canary's first line into the vault
  out="$(bash ops/scripts/monitoring-results-sync.sh 2>&1 | tail -1)"
  case "$out" in MONITORING_RESULTS_SYNC_VERDICT=PASS) ;; *FAIL*) red="$red L5:sync-fail" ;; *) ind="$ind L5:sync-$out" ;; esac
  if [ -r "$VAULT_RESULTS" ]; then
    grep -q "\"canary\":\"$CANARY_ID\"" "$VAULT_RESULTS" || ind="$ind L5:no-result-line-yet"
  else ind="$ind L5:vault-results-unreadable"; fi
  if [ -n "$red" ]; then echo "red:${red# }${ind:+ ind:${ind# }}"; elif [ -n "$ind" ]; then echo "ind:${ind# }"; else echo ok; fi
}

self_test() {
  local pass=0 fail=0
  ck() { local name="$1" want="$2" want_rc="$3"; shift 3; local got rc; got="$(decide "$@" 2>/dev/null)"; rc=$?
    if [ "$got" = "$want" ] && [ "$rc" -eq "$want_rc" ]; then pass=$((pass + 1)); echo "SELF-TEST: ok $name"
    else fail=$((fail + 1)); echo "SELF-TEST: FAIL $name (got '$got' rc=$rc)"; fi; }
  local M='MUTATIONS killed=14 of=14 errored=0'
  ck code-green CH4_CODE_GREEN 0 code passed passed ok "$M" n/a
  ck full-green CH4_GREEN 0 full passed passed ok "$M" ok
  ck synthetic-fail CH4_RED 1 full passed passed ok "$M" 'red:L4:x'
  ck suites-red CH4_RED 1 code failed passed ok "$M" n/a
  ck survived CH4_RED 1 code passed passed ok 'MUTATIONS killed=13 of=14 errored=0' n/a
  ck errored-ind CH4_INDETERMINATE 3 code passed passed ok 'MUTATIONS killed=13 of=14 errored=1' n/a
  ck vacuous-ind CH4_INDETERMINATE 3 code passed passed ok 'MUTATIONS killed=3 of=3 errored=0' n/a
  ck control-ind CH4_INDETERMINATE 3 code passed passed ok 'MUTATIONS control=FAIL (x)' n/a
  ck missing-token-ind CH4_INDETERMINATE 3 code passed passed ok '' n/a
  ck rider3-red CH4_RED 1 code passed passed 'red:freshness-consumer-changed(65/66)' "$M" n/a
  ck rider3-ind CH4_INDETERMINATE 3 code passed passed 'ind:unread' "$M" n/a
  ck install-ind CH4_INDETERMINATE 3 full passed passed ok "$M" 'ind:L5:no-result-line-yet'
  ck red-outranks-ind CH4_RED 1 full passed missing ok "$M" 'red:L4:x'
  ck code-ignores-install CH4_CODE_GREEN 0 code passed passed ok "$M" 'red:L4:x'
  # the missing-tool guard through the real entry point, with a PATH that holds only bash
  local tmp; tmp="$(mktemp -d)"; ln -s "$(command -v bash)" "$tmp/bash"
  local out rc; out="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" --code-only 2>&1)"; rc=$?
  rm -rf "$tmp"
  if [ "$(printf '%s\n' "$out" | tail -n 1)" = 'CH4_INDETERMINATE' ] && [ "$rc" -eq 3 ] && printf '%s' "$out" | grep -q "required tool 'ssh' not on PATH"; then pass=$((pass + 1)); echo 'SELF-TEST: ok missing-tool'
  else fail=$((fail + 1)); echo "SELF-TEST: FAIL missing-tool (got '$out' rc=$rc)"; fi
  if [ "$fail" -eq 0 ] && [ "$pass" -ge 15 ]; then echo "LRW_CH4_GATE_SELFTEST: PASS ($pass checks)"; exit 0; fi
  echo "LRW_CH4_GATE_SELFTEST: FAIL ($fail of $((pass + fail)))"; exit 1
}

if (return 0 2>/dev/null); then return 0; fi
if [ "${1:-}" = "--self-test" ]; then self_test; fi

MODE=full; [ "${1:-}" = "--code-only" ] && MODE=code
for t in "${REQUIRED_TOOLS[@]}"; do
  command -v "$t" >/dev/null 2>&1 || { echo "[lrw-ch4-gate] required tool '$t' not on PATH" >&2; echo 'CH4_INDETERMINATE'; exit 3; }
done
cd "$(git rev-parse --show-toplevel)" || { echo 'CH4_INDETERMINATE'; exit 3; }

suites=missing
if npx vitest run "${SUITES[@]}" > "${TMPDIR:-/tmp}/lrw-ch4-suites.log" 2>&1; then suites=passed
elif grep -qE '^\s*Tests\s+.*[0-9]+ failed' "${TMPDIR:-/tmp}/lrw-ch4-suites.log"; then suites=failed; fi
grep -E '^\s*(Test Files|Tests)\s' "${TMPDIR:-/tmp}/lrw-ch4-suites.log" >&2

selftest=missing
st_out="$(python3 -B "$CANARY" --self-test 2>&1 | tail -1)"
case "$st_out" in *"SELFTEST: PASS"*) selftest=passed ;; *"SELFTEST: FAIL"*) selftest=failed ;; esac
echo "[lrw-ch4-gate] canary self-test (Mac): $st_out" >&2

r3="$(rider3)"
echo "[lrw-ch4-gate] rider 3: $r3" >&2

tmp="$(mktemp -d "${TMPDIR:-/tmp}/lrw-ch4-gate.XXXXXX")" || { echo CH4_INDETERMINATE; exit 3; }
mutation_table > "$tmp/mutations.json"; mutation_driver > "$tmp/driver.js"
mut="$(node "$tmp/driver.js" "$(pwd)" "$tmp" "$tmp/mutations.json" | tail -1)"
rm -rf "$tmp"
echo "[lrw-ch4-gate] $mut" >&2

inst=n/a
if [ "$MODE" = full ]; then inst="$(install_legs)"; echo "[lrw-ch4-gate] install legs: $inst" >&2; fi

echo "[lrw-ch4-gate] mode=$MODE suites=$suites canary-selftest=$selftest" >&2
decide "$MODE" "$suites" "$selftest" "$r3" "$mut" "$inst"
exit $?
