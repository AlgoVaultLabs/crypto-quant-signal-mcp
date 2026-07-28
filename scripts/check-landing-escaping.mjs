#!/usr/bin/env node
// @ts-check
/**
 * check-landing-escaping.mjs — escape-lint for static landing pages.
 *
 * AUTHORED by OPS-AUDIT-REMEDIATION-CRITICAL-W1 as the generator-level fix for SEC-01: a
 * reflected DOM XSS on https://algovault.com/verify. `landing/verify.html` read `?signalId=` /
 * `?id=` / `?hash=`, auto-invoked the lookup on page load, and concatenated the RAW parameter
 * into an `innerHTML` string. `landing/index.html` already had an `escapeHtml` helper (17 call
 * sites); `verify.html` had ZERO. That asymmetry is exactly what this canary makes impossible.
 *
 * RULE: in any landing page, a value interpolated into an `innerHTML` / `insertAdjacentHTML` /
 * `document.write` string must be a literal, a local style/config constant, or wrapped in an
 * escaping helper. An unwrapped identifier fails the gate.
 *
 * Usage:
 *   node scripts/check-landing-escaping.mjs             # lint landing/**.html
 *   node scripts/check-landing-escaping.mjs --self-test # prove the detector both fires and doesn't
 * Exit: 0 = clean · 1 = unescaped interpolation found (or self-test failed).
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

/** Wrappers that render a value inert. Anything else interpolated is a finding. */
const SAFE_WRAPPERS = /^(escapeHtml|safeUrl|encodeURIComponent|encodeURI|Number|parseInt|parseFloat|String\(\s*Number)\s*\(/;

/** Local presentation constants — not data, never attacker-controlled. */
const SAFE_IDENTIFIERS = /^(rowStyle|labelStyle|valueStyle|cardStyle|style|cls|className|API_BASE|BASE|TZ)$/;

/**
 * Intra-file dataflow, deliberately shallow but sound:
 *
 *  (a) a variable assigned from a safe wrapper — `var sym = escapeHtml(r.slug)` — is itself safe
 *      wherever it is later interpolated. landing/index.html escapes at ASSIGNMENT and
 *      interpolates the bare name, which is correct and must not be flagged.
 *  (b) a function whose every `return` is a string LITERAL — `dirColor`, `callClass` — can only
 *      ever yield a fixed value, so its call is safe.
 *
 * Anything the two rules cannot prove safe is reported. Under-approximating here is deliberate:
 * a false hit is resolved by wrapping the value, which is never wrong.
 */
function safeNames(src) {
  const vars = new Set();
  const ASSIGN = /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(escapeHtml|safeUrl|encodeURIComponent|encodeURI)\s*\(/g;
  let m;
  while ((m = ASSIGN.exec(src)) !== null) vars.add(m[1]);

  // Brace-count the body rather than regex it: a lazy `…}` stops at the first NESTED brace
  // (`if (x) { return 'a'; } return 'b';`) and a `\n\s*}` anchor misses single-line functions.
  // Both mistakes silently drop a helper from the safe set and produce false positives.
  // Both forms occur in landing/: `function dirColor(d){…}` and `var dirColor = function(d){…}`
  // (and the arrow equivalent). Matching only the declaration form misses the latter, which is
  // what landing/index.html:386 actually uses.
  const fns = new Set();
  const FN_HEAD = /(?:function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)|(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:function\s*\([^)]*\)|\([^)]*\)\s*=>))\s*\{/g;
  while ((m = FN_HEAD.exec(src)) !== null) {
    const name = m[1] || m[2];
    let depth = 1;
    let i = FN_HEAD.lastIndex;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    const body = src.slice(FN_HEAD.lastIndex, i - 1);
    const returns = body.match(/return\s+[^;]+;/g) || [];
    if (returns.length && returns.every((r) => /return\s+(['"`])[^'"`]*\1\s*;/.test(r))) fns.add(name);
  }
  return { vars, fns };
}

/**
 * Extract the right-hand side of every `X.innerHTML = …` / `insertAdjacentHTML(…)` /
 * `document.write(…)` assignment, plus any string-concatenation expression passed to a
 * function whose body assigns innerHTML (the `setAll(...)` shape that carried SEC-01).
 */
function findInterpolations(src) {
  const findings = [];
  const lines = src.split('\n');
  const { vars: SAFE_VARS, fns: LITERAL_FNS } = safeNames(src);

  // A concatenation fragment: `' + expr + '`. We only care about ones inside a line that is
  // part of an HTML-string build — i.e. the line also contains an HTML tag fragment or is
  // inside a setAll/innerHTML expression. Being generous here is fine: a false hit is fixed
  // by wrapping the value, which is always correct.
  const CONCAT = /['"`]\s*\+\s*([A-Za-z_$][\w$.]*(?:\([^()]*\))?)\s*\+\s*['"`]/g;

  let inHtmlBuild = false;
  lines.forEach((line, i) => {
    if (/(innerHTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(|setAll\s*\()/.test(line)) inHtmlBuild = true;
    // A build expression ends at a line that closes the call/assignment.
    const looksHtml = /<\/?[a-z]|&middot;|&nbsp;|style="/.test(line);
    if (!inHtmlBuild && !looksHtml) return;

    let m;
    CONCAT.lastIndex = 0;
    while ((m = CONCAT.exec(line)) !== null) {
      const expr = m[1];
      if (SAFE_WRAPPERS.test(expr)) continue;
      if (SAFE_IDENTIFIERS.test(expr)) continue;
      if (SAFE_VARS.has(expr)) continue;                                  // escaped at assignment
      const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(expr);
      if (call && LITERAL_FNS.has(call[1])) continue;                     // returns only literals
      findings.push({ line: i + 1, expr, text: line.trim().slice(0, 120) });
    }
    if (/\);\s*$|^\s*\}/.test(line)) inHtmlBuild = false;
  });
  return findings;
}

const VULNERABLE_FIXTURE = `
  var id = params.get('signalId');
  function setAll(c){ mount.innerHTML = c; }
  setAll('<p>No call with ID ' + id + ' exists.</p>');
`;
const SAFE_FIXTURE = `
  var id = params.get('signalId');
  function setAll(c){ mount.innerHTML = c; }
  setAll('<p>No call with ID ' + escapeHtml(id) + ' exists.</p>');
`;
// Real shapes from landing/index.html that MUST NOT be flagged: escaped at assignment, and a
// helper whose every return is a string literal.
const SAFE_ASSIGNMENT_FIXTURE = `
  var dirColor = function(d){ if (d === 'BUY') { return 'oklch(0.8 0.1 150)'; } return 'oklch(0.78 0.005 265)'; };
  var sym = escapeHtml(r.slug || '');
  el.innerHTML = '<span style="color:' + dirColor(d) + '">' + sym + '</span>';
`;

function selfTest() {
  const fails = [];
  const vuln = findInterpolations(VULNERABLE_FIXTURE);
  if (!vuln.some((f) => f.expr === 'id')) fails.push('MISSED the synthetic vulnerable snippet (raw `id` into innerHTML)');
  const safe = findInterpolations(SAFE_FIXTURE);
  if (safe.length) fails.push(`FALSE POSITIVE on the escaped snippet: ${safe.map((f) => f.expr).join(', ')}`);
  const safe2 = findInterpolations(SAFE_ASSIGNMENT_FIXTURE);
  if (safe2.length) fails.push(`FALSE POSITIVE on escaped-at-assignment / literal-return: ${safe2.map((f) => f.expr).join(', ')}`);
  return fails;
}

if (argv.includes('--self-test')) {
  const fails = selfTest();
  if (fails.length) { console.error('✖ escape-lint self-test FAILED:'); fails.forEach((f) => console.error('   - ' + f)); process.exit(1); }
  console.log('✓ escape-lint self-test passed (fires on raw param → innerHTML; silent on escapeHtml())');
  process.exit(0);
}

// Fail closed if the detector itself is broken — a vacuous lint is worse than none.
const stFails = selfTest();
if (stFails.length) { console.error('✖ escape-lint self-test FAILED — refusing to report a vacuous pass:'); stFails.forEach((f) => console.error('   - ' + f)); process.exit(1); }

const files = execFileSync('git', ['ls-files', 'landing'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => f.endsWith('.html'));

let total = 0;
const offenders = [];
for (const f of files) {
  const abs = join(ROOT, f);
  if (!existsSync(abs)) continue;
  total++;
  const hits = findInterpolations(readFileSync(abs, 'utf8'));
  hits.forEach((h) => offenders.push(`${f}:${h.line}  ${h.expr}  →  ${h.text}`));
}

if (offenders.length) {
  console.error(`✖ escape-lint: ${offenders.length} unescaped interpolation(s) into an HTML sink across ${total} landing page(s):`);
  offenders.forEach((o) => console.error('   - ' + o));
  console.error('\n  Wrap the value in escapeHtml(...) (or safeUrl(...) for an href).');
  console.error('  See landing/index.html:338 for the canonical helper.');
  process.exit(1);
}
console.log(`✓ escape-lint: no unescaped interpolation into an HTML sink across ${total} landing page(s).`);
process.exit(0);
