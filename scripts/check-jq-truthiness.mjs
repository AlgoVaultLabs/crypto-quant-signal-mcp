#!/usr/bin/env node
/**
 * check-jq-truthiness.mjs — OPS-TEST-GATE-VACUITY-W1
 *
 * `jq -e` on a CONTAINER is a vacuity hole: it exits non-zero only for `false` and
 * `null`, so `[]`, `{}`, `""` and `0` are all "true". Measured on jq-1.7.1-apple:
 *
 *     echo '{"testResults":[]}' | jq -e '.testResults' ; echo $?   ->  0
 *
 * That is how `check_test_baseline.sh` came to print PASS over a report containing zero
 * results — the gate every other gate's evidence depends on. This lint makes the shape
 * unwritable: a `jq -e` filter must evaluate an EXPLICIT BOOLEAN, never a bare path.
 *
 * ── HONEST SCOPE NOTE ─────────────────────────────────────────────────────────
 * At the time of writing this lint found **ZERO existing violations**. It is a
 * FORWARD-GUARD, not a remediation: its value is that the bug becomes unwritable, not
 * that it cleaned anything up. Recorded here so a later reader does not mistake
 * "lint shipped" for "N bugs fixed", and does not re-investigate a settled negative.
 *
 * ── WHY THIS SCOPE, AND WHY NO ALLOWLIST ──────────────────────────────────────
 * Invocation and mention are separated STRUCTURALLY, not by a maintained exemption list
 * (a hand-maintained allowlist guarding a currently-empty class is negative value, and
 * this estate has a documented pattern of exemptions being "fixed" by later waves).
 * Scanned: executable shell scripts under scripts/ and ops/, plus CI workflows — the
 * places a `jq -e` actually RUNS as a command. Deliberately NOT scanned, each for a
 * reason rather than by omission:
 *   tests/**  — mentions, not invocations. `expect(cmd).toMatch(/jq -e/)` asserts that a
 *               drift-check command contains the string; linting it would demand deleting
 *               a legitimate assertion.
 *   audits/** — `drift_check_command` DATA. Operator-run rather than CI-run, and every
 *               one was verified an explicit boolean when this shipped. This is the one
 *               real coverage boundary; it is declared, not hidden.
 *   *.md      — prose, including docblocks that quote the historical buggy form. Those
 *               quotes are the most valuable lines in the file (OPS-TEST-GATE-RECONCILE-W1
 *               codified exactly this after a naive ban-grep demanded deleting one).
 *
 * ── EXIT CODES ────────────────────────────────────────────────────────────────
 *   0 = PASS · 1 = FAIL · 3 = INDETERMINATE
 * The 3 is the token-law DEFAULT for a NEW gate and is NOT a repeat of the 2-vs-3 drift.
 * `check_test_baseline.sh` uses 2 because it ALREADY DEPLOYED 2 for that meaning; a gate
 * diverges from the default only when it has an incumbent code. Nothing reads both
 * spaces, so this divergence costs nothing and must not be "aligned".
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = path.basename(fileURLToPath(import.meta.url));
const VERDICT = (tok, code) => { console.log(`JQ_TRUTHINESS_VERDICT=${tok}`); process.exit(code); };

/** A filter is SAFE when it evaluates to an explicit boolean rather than a container. */
export function filterIsExplicitBoolean(filter) {
  return /(==|!=|>=|<=|>|<|\bhas\(|\band\b|\bor\b|\bnot\b|\bany\b|\ball\b|\bcontains\(|\btest\(|\bstartswith\(|\bendswith\(|\bindex\(|\bIN\(|\btrue\b|\bfalse\b)/.test(filter);
}

/** Strip whole-line comments so a docblock quoting the buggy form is never a violation. */
export function stripComments(src) {
  return src
    .split('\n')
    .map((l) => (/^\s*(#|\/\/|\*|<!--)/.test(l) ? '' : l))
    .join('\n');
}

/** Extract every `jq -e` invocation's filter from already-comment-stripped source. */
export function findJqEFilters(src) {
  const out = [];
  const re = /jq\s+-e\s*(?:-[A-Za-z-]+\s+)*(['"])([\s\S]*?)\1/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ filter: m[2], index: m.index });
  }
  return out;
}

function lineOf(src, idx) { return src.slice(0, idx).split('\n').length; }

function scan() {
  let files;
  try {
    files = execFileSync('git', ['ls-files', 'scripts/*.sh', 'ops/**/*.sh', '.github/workflows/*.yml'],
      { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch (e) {
    console.error(`[jq-truthiness] cannot enumerate tracked files: ${e.message}`);
    VERDICT('INDETERMINATE', 3);
  }
  files = files.filter((f) => path.basename(f) !== SELF);
  if (files.length === 0) {
    // We CONSTRUCT this corpus from git, so empty means the enumeration broke — a defect
    // in the check, not a fact about the world. Refuse rather than report a clean pass.
    console.error('[jq-truthiness] scope resolved to ZERO files — refusing to report a pass.');
    VERDICT('INDETERMINATE', 3);
  }

  const violations = [];
  let invocations = 0;
  for (const f of files) {
    let src;
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    const clean = stripComments(src);
    for (const { filter, index } of findJqEFilters(clean)) {
      invocations += 1;
      if (!filterIsExplicitBoolean(filter)) {
        violations.push(`${f}:${lineOf(clean, index)}  jq -e '${filter.slice(0, 70)}'`);
      }
    }
  }
  return { files: files.length, invocations, violations };
}

function selfTest() {
  const fails = [];
  const eq = (label, got, want) => { if (got !== want) fails.push(`${label}: got ${got} want ${want}`); };

  // UNSAFE — every container jq -e calls "true"
  for (const f of ['.testResults', '.items', '.a.b.c', '.', '.data[]'])
    eq(`unsafe: ${f}`, filterIsExplicitBoolean(f), false);
  // SAFE — explicit booleans
  for (const f of ['(.testResults // []) | length > 0', 'has("version")', '.total > 0',
                   '.a == 1', '[.x[].n] | contains(["y"])', '.ok != null'])
    eq(`safe: ${f}`, filterIsExplicitBoolean(f), true);

  // Comment stripping — the docblock above quotes the buggy form and must NOT trip us.
  eq('comment-stripped # line', findJqEFilters(stripComments(`# jq -e '.testResults'`)).length, 0);
  eq('comment-stripped // line', findJqEFilters(stripComments(`// jq -e '.testResults'`)).length, 0);
  eq('comment-stripped * line', findJqEFilters(stripComments(` * jq -e '.testResults'`)).length, 0);
  eq('real invocation still seen', findJqEFilters(stripComments(`jq -e '.x' f.json`)).length, 1);

  // The detector must fire on the ORIGINAL buggy bytes, and be clean on the fixed ones.
  const buggy = `report_usable() { jq -e '.testResults' "$1" >/dev/null 2>&1; }`;
  const fixed = `report_usable() { jq -e '(.testResults // []) | length > 0' "$1" >/dev/null 2>&1; }`;
  eq('fires on the historical buggy bytes',
     findJqEFilters(stripComments(buggy)).filter((x) => !filterIsExplicitBoolean(x.filter)).length, 1);
  eq('clean on the shipped fixed bytes',
     findJqEFilters(stripComments(fixed)).filter((x) => !filterIsExplicitBoolean(x.filter)).length, 0);

  if (fails.length) {
    fails.forEach((f) => console.error(`  ✗ ${f}`));
    console.error(`[jq-truthiness] self-test FAILED (${fails.length})`);
    VERDICT('FAIL', 1);
  }
  // Vacuity anchored on the SUMMARY, never a per-case line (OPS-TEST-GATE-RECONCILE-W1:
  // a per-case regex matched `must-map: … ⇒ exit 0` and the real count was never checked).
  const total = 5 + 6 + 4 + 2;
  console.log(`[jq-truthiness] self-test passed (${total} assertions)`);
  if (total === 0) VERDICT('INDETERMINATE', 3);
  VERDICT('PASS', 0);
}

if (process.argv.includes('--self-test')) selfTest();

const { files, invocations, violations } = scan();
console.log(`[jq-truthiness] scanned ${files} executable/CI files, ${invocations} jq -e invocation(s)`);
if (violations.length) {
  console.error('[jq-truthiness] `jq -e` on a bare path/container — it exits 0 for [], {}, "" and 0:');
  violations.forEach((v) => console.error(`  - ${v}`));
  console.error('[jq-truthiness] use an explicit boolean, e.g. `(.x // []) | length > 0`.');
  VERDICT('FAIL', 1);
}
VERDICT('PASS', 0);
