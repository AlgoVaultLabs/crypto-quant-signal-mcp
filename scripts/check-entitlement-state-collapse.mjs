#!/usr/bin/env node
/**
 * OPS-VALIDATE-KEY-INDETERMINATE-W1 CH5 L2 — no route may answer an entitlement question with a
 * body that cannot say WHICH answer it is.
 *
 * ── THE PATTERN THIS BANS ─────────────────────────────────────────────────────────────────────
 * Three routes independently carried
 *
 *     if (!result.valid || !result.tier) return res.status(404).json({ valid: false });
 *
 * and that one line was the answer to FOUR different questions: "no such customer", "their card
 * is failing and Stripe is still collecting", "their subscription ended", and "we could not reach
 * Stripe". It even discarded `indeterminate: true`, which `validateApiKey` had been setting
 * correctly for months. Downstream, `entitlement_drain.py` treats 404 as TERMINAL — it stamps
 * `key_invalid_404` and never charges or retries that debit again — so the collapse did not just
 * lose information, it forgave revenue: 1,987 uncharged debits and 2,025 delivered alerts for one
 * `past_due` customer across nine days (measured 2026-09-04).
 *
 * ── WHY A GATE RATHER THAN THE UNIT TESTS ALONE ───────────────────────────────────────────────
 * `tests/unit/entitlement-http-projection.test.ts` pins the projection, but a FOURTH route added
 * next month can hand-roll its own `res.status(404).json({valid:false})` and every existing test
 * still passes — the new route simply is not in them. This gate is corpus-wide, so it sees a
 * route the tests have never heard of.
 *
 * LEG A  no `res.status(...).json({...})` body may carry `valid` without `entitlement_state`.
 * LEG B  a file that routes AND calls `validateApiKey` must project through
 *        `projectEntitlementHttp` — it may not re-derive the HTTP answer itself.
 *
 * CONTRACT: exactly one terminal `ENTITLEMENT_STATE_COLLAPSE_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Callers gate on the TOKEN, never the exit code. Exit 0=PASS, 1=FAIL, 3=INDETERMINATE.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'node:path';
// ONE implementation of comment-stripping, imported rather than copied: two copies of a text
// scanner drift, and this one already had to be fixed once for reading a docstring as code.
import { listTsFiles, stripComments } from './check-subscription-status-sot.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/** `res.status(N).json({ … })` bodies, with the object-literal text and 1-based line. */
export function findStatusJsonBodies(code) {
  const out = [];
  const re = /res\s*\.\s*status\s*\([^)]*\)\s*\.\s*json\s*\(\s*\{/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const open = code.indexOf('{', m.index + m[0].length - 1);
    let depth = 0;
    let end = -1;
    for (let j = open; j < code.length; j++) {
      if (code[j] === '{') depth++;
      else if (code[j] === '}' && --depth === 0) { end = j; break; }
    }
    if (end === -1) continue;
    out.push({ line: code.slice(0, m.index).split('\n').length, body: code.slice(open, end + 1) });
  }
  return out;
}

/** A body that asserts `valid` must also say WHICH state produced it. */
export function collapsesState(body) {
  return /(^|[{,\s])valid\s*:/.test(body) && !/entitlement_state\s*:/.test(body);
}

export function routesEntitlement(code) {
  return /app\s*\.\s*(get|post|put|patch|delete)\s*\(/.test(code) && /validateApiKey\s*\(/.test(code);
}

export function scan(files, read) {
  const violations = [];
  let bodies = 0;
  let routeFiles = 0;
  for (const f of files) {
    const code = stripComments(read(f));
    for (const b of findStatusJsonBodies(code)) {
      bodies++;
      if (collapsesState(b.body)) {
        violations.push({ file: f, line: b.line, leg: 'A', detail: 'body asserts `valid` with no `entitlement_state`' });
      }
    }
    if (routesEntitlement(code)) {
      routeFiles++;
      if (!/projectEntitlementHttp\s*\(/.test(code)) {
        violations.push({ file: f, line: 1, leg: 'B', detail: 'routes on validateApiKey without projecting through projectEntitlementHttp' });
      }
    }
  }
  return { bodies, routeFiles, violations };
}

function run() {
  let files;
  try {
    files = listTsFiles(SRC);
  } catch (err) {
    console.error(`[state-collapse] cannot read ${SRC}: ${err.message}`);
    console.log('ENTITLEMENT_STATE_COLLAPSE_VERDICT=INDETERMINATE');
    return 3;
  }
  const r = scan(files, (f) => readFileSync(f, 'utf8'));

  // VACUITY GUARD at the CONSTRUCTION site. Leg B has a real corpus only if at least one file
  // actually routes on validateApiKey; zero means the routes moved and this gate sees nothing.
  if (r.routeFiles === 0) {
    console.error('[state-collapse] ZERO files route on validateApiKey — the routes moved; this gate is checking nothing.');
    console.log('ENTITLEMENT_STATE_COLLAPSE_VERDICT=INDETERMINATE');
    return 3;
  }

  console.log(`[state-collapse] ${r.bodies} res.status().json({}) bodies across ${files.length} file(s); ${r.routeFiles} entitlement route file(s); ${r.violations.length} violation(s).`);
  for (const v of r.violations) {
    console.error(`  ✖ [leg ${v.leg}] ${relative(ROOT, v.file)}:${v.line}  ${v.detail}`);
    console.error('     Project through `projectEntitlementHttp(result)` — see src/lib/entitlement-http.ts.');
  }
  console.log(`ENTITLEMENT_STATE_COLLAPSE_VERDICT=${r.violations.length === 0 ? 'PASS' : 'FAIL'}`);
  return r.violations.length === 0 ? 0 : 1;
}

// ── self-test ────────────────────────────────────────────────────────────────
// TWO-WAY: every clean case is paired with a dirty one that MUST be caught, so the suite cannot
// pass against a `scan` that returns no violations.
function selfTest() {
  const cases = [];
  const t = (n, ok) => cases.push([n, ok]);
  const one = (src) => scan(['x.ts'], () => src);

  const collapse = `return res.status(404).json({ valid: false });`;
  const projected = `return res.status(p.status).json({ valid: false, entitlement_state: 'NOT_ENTITLED' });`;
  const unrelated = `return res.status(400).json({ error: 'api_key_required' });`;
  const routeOk = `app.get('/x', async () => { const r = await validateApiKey(k); const p = projectEntitlementHttp(r); });`;
  const routeBad = `app.get('/x', async () => { const r = await validateApiKey(k); if (!r.valid) return res.status(404).json({ ok: false }); });`;

  t('the bare {valid:false} collapse is CAUGHT', one(collapse).violations.some((v) => v.leg === 'A'));
  t('a body carrying entitlement_state is clean', one(projected).violations.length === 0);
  t('an unrelated 400 body is not flagged', one(unrelated).violations.length === 0);
  t('a route projecting through the SoT is clean', one(routeOk).violations.length === 0);
  t('a route re-deriving its own HTTP answer is CAUGHT (leg B)', one(routeBad).violations.some((v) => v.leg === 'B'));
  t('the collapse QUOTED IN A COMMENT is not a violation', one(`// ${collapse}\nconst x = 1;`).violations.length === 0);
  t('a nested object in the body does not truncate the scan',
     one(`res.status(404).json({ meta: { a: 1 }, valid: false });`).violations.some((v) => v.leg === 'A'));
  t('leg B denominator is what the vacuity guard reads', one(routeOk).routeFiles === 1);
  t('a non-routing file contributes no leg-B corpus', one(collapse).routeFiles === 0);

  if (cases.length === 0) {
    console.error('[state-collapse] self-test built ZERO cases');
    console.log('ENTITLEMENT_STATE_COLLAPSE_VERDICT=INDETERMINATE');
    return 3;
  }
  let failed = 0;
  for (const [n, ok] of cases) { console.log(`  ${ok ? '✓' : '✖'} ${n}`); if (!ok) failed++; }
  console.log(`[state-collapse] self-test: ${cases.length - failed}/${cases.length} passed.`);
  console.log(`ENTITLEMENT_STATE_COLLAPSE_VERDICT=${failed === 0 ? 'PASS' : 'FAIL'}`);
  return failed === 0 ? 0 : 1;
}

// ── entrypoint guard ─────────────────────────────────────────────────────────
// 🛑 REQUIRED, and caught by CH5 L2's own first run. This module is IMPORTED by
// `check-entitlement-state-collapse.mjs` for its comment-stripping helper, and a top-level
// `process.exit(...)` runs the whole gate — and exits the importing process — at import time.
// L2 printed L1's verdict and stopped. A shared helper must not be an entrypoint side effect.
const isMain = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();
if (isMain) process.exit(process.argv.includes('--self-test') ? selfTest() : run());
