#!/usr/bin/env node
/**
 * check-population-comparison.mjs — EDGE-POPULATION-COMPARISON-W1.
 *
 * THE GATE THAT MAKES THE COMPARATOR CLASS ENUMERABLE, AND ITS DEBT MONOTONE.
 *
 * The defect it exists for, measured on production 2026-09-02: a monitoring gate compared a rate
 * across two populations against `max(always_long, always_short)`. `always_short` moved +2.97pp
 * between the two windows, and the gate attributed that market move to the change under test —
 * firing a FALSE rollback alarm on a live revenue product.
 *
 * ── WHY A GATE AND NOT ANOTHER RULE ──────────────────────────────────────────────────────────
 * CLAUDE.md's Benchmark-before-publish LAW already mandated edge "against the naive baselines on
 * the same rows". IT WAS FOLLOWED. "Same rows" controls the market WITHIN an arm and is silent on
 * BETWEEN arms, and following it is precisely what produced `max(long, short)` as the comparator.
 * A correctly-followed rule that produces the defect cannot be fixed by writing the rule again —
 * compliance is false assurance, and review cannot catch what it is told is correct.
 *
 * ── WHAT IT ACTUALLY BUYS, STATED HONESTLY ───────────────────────────────────────────────────
 * Pass 1 is a TRIPWIRE, not a proof: a rename, a loop accumulating a max, or a helper called
 * `bestOf` evades it. The enumeration in the registry is what makes the population knowable, and
 * the RATCHET is what makes the debt monotone. Together: the correct answer is the default, the
 * wrong answer must be declared in a file a human reads, and non-use is expensive rather than free.
 *
 * ── DECLARATION-TIME IDENTIFIABILITY (OPS-PREREG-IDENTIFIABILITY-GATE-W1) ────────────────────
 * A site that declares a floor must also declare the side share it was sized against, and a floor
 * the narrowest arm can never show is refused HERE, when the site is declared, instead of at
 * readout. The 2026-08-31 trend-mode trigger A (3.0pp floor; v1 minority share 0.0053, so 2m =
 * 1.06pp) was refused by `compare_arms` only after it had already been declared and armed. The bound
 * is NOT computed in this file: `attainable_bound_from_share` lives once, in
 * ops/monitoring/population_comparison.py beside `Arm.attainable_pp`, and is reached by subprocess
 * through `--declarations`. A second copy of the formula here is exactly what that module forbids.
 * An evaluator that cannot run is INDETERMINATE — never a pass, and never a refusal.
 *
 * Verdict contract: exactly one terminal `POPULATION_COMPARISON_GATE_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit 0=PASS / 1=FAIL / 3=INDETERMINATE (3 is the token-law default for a NEW gate; do not
 * "align" it with check_test_baseline.sh's 2, which is 2 only because it already deployed 2).
 * Callers gate on the TOKEN, never the exit code.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const REGISTRY = join(ROOT, 'ops/monitoring/population-comparison.registry.json');
const SCHEMA = join(ROOT, 'ops/monitoring/population-comparison.schema.json');
const PY_DERIVATION = join(ROOT, 'ops/monitoring/population_comparison.py');
const IDENT_FIXTURES = join(ROOT, 'tests/fixtures/identifiability');

const PASS = 'PASS', FAIL = 'FAIL', INDET = 'INDETERMINATE';

/**
 * The banned SHAPE: a max/greatest over two or more naive directional baselines.
 * Deliberately narrow and deliberately advertised as incomplete — see the honesty note above.
 */
const BANNED_SHAPE =
  /(?:Math\.max|max|greatest|GREATEST)\s*\([^)]*\balways[_-]?(?:buy|sell|long|short)[^)]*\)/i;
// NOTE THE ABSENT TRAILING \b, AND WHY. The first draft required a word boundary after
// buy/sell/long/short, so `alwaysBuyWr` and `alwaysBuyDwr` — the forms this repo ACTUALLY uses at
// calibration-audit.ts:94 and dwr-baseline.ts:122 — did not match, and the live sweep reported ONE
// hit where FOUR exist while printing PASS. It was caught only because the self-test fixtures below
// are copied from real source lines rather than hand-written approximations of them; a fixture
// written as `Math.max(alwaysBuy, alwaysSell)` passes against a regex that cannot read this repo.

/** Files whose CONTENT is scanned. Data and docs are enumerated via the registry, not the sweep. */
const SCAN_DIRS = ['src', 'ops', 'scripts'];
const SCAN_EXT = /\.(ts|tsx|js|mjs|cjs|py|sh)$/;

/**
 * A mention is not an invocation. Strip line comments and block comments before matching, the same
 * reason `check-canaries-wired.mjs` does — otherwise the most valuable line in a file (the docblock
 * explaining the historical buggy form) is the one the gate demands you delete.
 */
function stripComments(src, file) {
  let s = src;
  if (/\.(py|sh)$/.test(file)) {
    s = s.replace(/^\s*#.*$/gm, '');
    s = s.replace(/"""[\s\S]*?"""/g, '').replace(/'''[\s\S]*?'''/g, '');
  } else {
    s = s.replace(/\/\*[\s\S]*?\*\//g, '');
    s = s.replace(/^\s*\/\/.*$/gm, '');
    s = s.replace(/([^:])\/\/.*$/gm, '$1');
  }
  return s;
}

/**
 * THIS FILE IS EXCLUDED FROM ITS OWN SWEEP, and the reason is circularity rather than convenience.
 *
 * The self-test fixtures below are STRING LITERALS containing the banned form — they are how the
 * regex is proven to match what this repo actually writes, and they are what caught the first
 * draft's under-detection (1 hit where 4 exist). Comment-stripping cannot reach a string literal,
 * so without this exclusion the gate flags its own fixtures and its remediation is "delete the
 * evidence that you work". That is the documented trap one substrate over: a ban-grep whose most
 * valuable line is the one it demands you remove.
 *
 * SCOPED TO EXACTLY ONE FILE, and the self-test asserts the count, so this cannot quietly grow
 * into an allowlist. Same argument `check-declaration-coverage.mjs` makes for NOT_A_CONSUMER:
 * a gate that is its own subject can never be falsified by itself.
 *
 * THE HOLE THIS LEAVES, STATED: a real banned comparator written INSIDE this gate would not be
 * caught by this gate. It would still be caught by review and by the derivation's own self-test,
 * and this file computes no rates — it only matches text.
 */
export const SELF_EXCLUDED = new Set(['scripts/check-population-comparison.mjs']);

function tracked() {
  const out = execFileSync('git', ['-C', ROOT, 'ls-files', ...SCAN_DIRS], { encoding: 'utf8' });
  return out.split('\n').filter(f => f && SCAN_EXT.test(f) && !SELF_EXCLUDED.has(f));
}

const isFiniteNumber = (x) => typeof x === 'number' && Number.isFinite(x);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * SHAPE ONLY — which sites declare a floor, and is each declaration complete? Computes no bound.
 * Optional fields, documented in the registry's `_site_floor_doc`: `declared_floor_pp` (pp) and
 * `sized_against: [{arm, minority_side_share, probe}]`, one entry per arm the floor constrains.
 */
function siteFloorDeclarations(sites) {
  const requests = [];
  const errors = [];
  for (const s of sites) {
    const hasFloor = has(s, 'declared_floor_pp');
    const hasShare = has(s, 'sized_against');
    if (!hasFloor && !hasShare) continue;
    if (!hasFloor) {
      errors.push(`${s.id}: sized_against without a declared_floor_pp — a share sizes a floor; declare both or neither`);
      continue;
    }
    if (!isFiniteNumber(s.declared_floor_pp)) {
      errors.push(`${s.id}: declared_floor_pp must be a finite number of pp, got ${JSON.stringify(s.declared_floor_pp)}`);
      continue;
    }
    if (!Array.isArray(s.sized_against) || s.sized_against.length === 0) {
      errors.push(`${s.id}: declares a ${s.declared_floor_pp}pp floor without the side share it was sized against ` +
                  `(sized_against: [{arm, minority_side_share, probe}])`);
      continue;
    }
    const bad = s.sized_against.map((a, i) => {
      if (!a || typeof a !== 'object') return `sized_against[${i}] is not an object`;
      if (typeof a.arm !== 'string' || !a.arm.trim()) return `sized_against[${i}].arm must name the arm`;
      const m = a.minority_side_share;
      if (!isFiniteNumber(m) || m < 0 || m > 0.5) {
        return `sized_against[${i}].minority_side_share must be the MINORITY share, a fraction in [0, 0.5], ` +
               `got ${JSON.stringify(m)}`;
      }
      if (typeof a.probe !== 'string' || a.probe.trim().length < 10) {
        return `sized_against[${i}].probe must name the cardinality probe that produced the share`;
      }
      return null;
    }).filter(Boolean);
    if (bad.length) {
      errors.push(`${s.id}: ${bad.join('; ')}`);
      continue;
    }
    requests.push({
      id: s.id,
      floor_pp: s.declared_floor_pp,
      shares: s.sized_against.map(a => a.minority_side_share),
      arms: s.sized_against.map(a => a.arm),
    });
  }
  return { requests, errors };
}

/** The ONE bound, by subprocess. `{results}` or `{error}` — an error is INDETERMINATE, never a pass. */
function evaluateDeclarations(requests, script = PY_DERIVATION) {
  const payload = JSON.stringify({
    declarations: requests.map(({ id, floor_pp, shares }) => ({ id, floor_pp, shares })),
  });
  let out;
  try {
    out = execFileSync('python3', [script, '--declarations'],
      { input: payload, encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    const detail = String(e.stdout || e.stderr || e.message || e).trim().slice(0, 200);
    return { error: `python3 ${relative(ROOT, script)} --declarations failed (exit ${e.status ?? 'spawn'}): ${detail}` };
  }
  let doc;
  try { doc = JSON.parse(out); } catch { return { error: `--declarations printed non-JSON: ${out.slice(0, 120)}` }; }
  const results = doc && Array.isArray(doc.results) ? doc.results : null;
  if (!results || results.length !== requests.length) {
    return { error: `--declarations returned ${results ? results.length : 'no'} result(s) for ${requests.length} declaration(s)` };
  }
  for (let i = 0; i < results.length; i++) {
    if (results[i].id !== requests[i].id) {
      return { error: `--declarations result ${i} is for ${JSON.stringify(results[i].id)}, expected ${JSON.stringify(requests[i].id)}` };
    }
    if (results[i].verdict !== 'IDENTIFIABLE' && results[i].verdict !== 'NOT_IDENTIFIABLE') {
      return { error: `${requests[i].id}: --declarations could not decide (${results[i].verdict}: ${results[i].reason})` };
    }
  }
  return { results };
}

/** Detect, then judge: every floor-declaring site, its verdict, and what the leg could not evaluate. */
function identifiabilityLeg(sites, script = PY_DERIVATION) {
  const { requests, errors } = siteFloorDeclarations(sites);
  const lines = [];
  const fails = [...errors];
  const indet = [];
  let refused = 0;
  if (requests.length) {
    const ev = evaluateDeclarations(requests, script);
    if (ev.error) {
      indet.push(ev.error);
    } else {
      ev.results.forEach((r, i) => {
        const arm = requests[i].arms[r.binding_index];
        const floor = Number(r.floor_pp).toFixed(2);
        const bound = Number(r.bound_pp).toFixed(2);
        lines.push(`  ${r.verdict === 'NOT_IDENTIFIABLE' ? 'NOT_IDENTIFIABLE' : 'IDENTIFIABLE    '} ${r.id}  ` +
                   `floor ${floor}pp vs 2m ${bound}pp (narrowest arm: ${arm})`);
        if (r.verdict === 'NOT_IDENTIFIABLE') {
          refused++;
          fails.push(`${r.id}: NOT_IDENTIFIABLE — declared floor ${floor}pp exceeds 2m = ${bound}pp, the most arm ` +
                     `"${arm}" can ever show, so this site could never fire`);
        }
      });
    }
  }
  const declaring = requests.length + errors.length;
  const head = `[population-comparison] identifiability: ${declaring} site(s) declare a floor — ` +
    `${requests.length} evaluated via population_comparison.py --declarations, ${refused} NOT_IDENTIFIABLE, ` +
    `${errors.length} malformed` +
    (declaring === 0 ? ' (no site sizes its floor here yet; one that adds declared_floor_pp must carry sized_against)' : '');
  return { head, lines, fails, indet, evaluated: requests.length, refused, malformed: errors.length };
}

function run() {
  const notes = [];
  let registry, schema;
  try {
    registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
  } catch (e) {
    // Input we were HANDED and could not parse is INDETERMINATE, always.
    console.log(`[population-comparison] cannot read the contract: ${e.message}`);
    console.log(`POPULATION_COMPARISON_GATE_VERDICT=${INDET}`);
    return 3;
  }

  // Config we AUTHOR is CONSTRUCTED, so an empty declaration is vacuity and must refuse.
  if (!Array.isArray(registry.sites) || registry.sites.length === 0) {
    console.log('[population-comparison] registry declares zero sites — a corpus we construct ' +
                'being empty is a defect in the registry, not a fact about the world');
    console.log(`POPULATION_COMPARISON_GATE_VERDICT=${INDET}`);
    return 3;
  }
  if (!Array.isArray(schema.banned_basis) || schema.banned_basis.length === 0) {
    console.log('[population-comparison] schema declares no banned bases — vacuous contract');
    console.log(`POPULATION_COMPARISON_GATE_VERDICT=${INDET}`);
    return 3;
  }

  const files = tracked();
  // Input the WORLD gives us being empty would be a fact; but we build this list from git, so an
  // empty tree means the scan is broken, not that the repo has no source.
  if (files.length === 0) {
    console.log('[population-comparison] scanned zero files — the sweep searched nothing, which ' +
                'is indistinguishable from a clean sweep and must never report one');
    console.log(`POPULATION_COMPARISON_GATE_VERDICT=${INDET}`);
    return 3;
  }

  const declaredFiles = new Set(registry.sites.map(s => s.file));
  const hits = [];
  for (const f of files) {
    let src;
    try { src = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    const body = stripComments(src, f);
    body.split('\n').forEach((line, i) => {
      if (BANNED_SHAPE.test(line)) hits.push({ file: f, line: i + 1, text: line.trim().slice(0, 110) });
    });
  }

  const undeclared = hits.filter(h => !declaredFiles.has(h.file));
  const unmigrated = registry.sites.filter(s => s.status === 'UNMIGRATED');
  const missingWave = unmigrated.filter(s => !s.migration_wave);
  const baseline = Number(registry.unmigrated_baseline);

  // POSITIVE per-check output — a check silently skipped must not look like one that passed.
  console.log(`[population-comparison] scanned ${files.length} tracked files across ${SCAN_DIRS.join('/')}`);
  console.log(`[population-comparison] registry declares ${registry.sites.length} sites ` +
              `(${unmigrated.length} UNMIGRATED, baseline ${baseline})`);
  console.log(`[population-comparison] banned-shape hits: ${hits.length}, of which undeclared: ${undeclared.length}`);
  for (const h of hits.slice(0, 12)) {
    const tag = declaredFiles.has(h.file) ? 'declared  ' : 'UNDECLARED';
    console.log(`  ${tag} ${h.file}:${h.line}  ${h.text}`);
  }

  if (undeclared.length) {
    notes.push(`${undeclared.length} banned-comparator site(s) not declared in the registry`);
  }
  if (missingWave.length) {
    notes.push(`${missingWave.length} UNMIGRATED site(s) name no migration_wave — declared debt ` +
               `must name who will pay it`);
  }
  if (Number.isFinite(baseline) && unmigrated.length > baseline) {
    notes.push(`RATCHET: UNMIGRATED count ${unmigrated.length} exceeds baseline ${baseline} — ` +
               `the class may shrink, never grow`);
  }
  if (!Number.isFinite(baseline)) {
    console.log('[population-comparison] registry declares no numeric unmigrated_baseline');
    console.log(`POPULATION_COMPARISON_GATE_VERDICT=${INDET}`);
    return 3;
  }

  // Declaration-time identifiability — printed on EVERY run, including when nothing declares a floor.
  const ident = identifiabilityLeg(registry.sites);
  console.log(ident.head);
  for (const l of ident.lines) console.log(l);

  if (notes.length || ident.fails.length) {
    for (const n of notes) console.log(`[population-comparison] ✗ ${n}`);
    if (notes.length) {
      console.log('[population-comparison] remediation: add a row to ' +
                  relative(ROOT, REGISTRY) + ' with status, purpose, basis and a migration_wave, ' +
                  'or migrate the site to ops/monitoring/population_comparison.py');
    }
    for (const f of ident.fails) console.log(`[population-comparison] ✗ ${f}`);
    if (ident.fails.length) {
      console.log('[population-comparison] remediation (identifiability): a refused floor is restated — e.g. as ' +
                  "a within-arm test — or sized to the narrowest arm's 2m; a floor needs the share it was sized against");
    }
    for (const i of ident.indet) console.log(`[population-comparison] ? ${i}`);
    console.log(`POPULATION_COMPARISON_GATE_VERDICT=${FAIL}`);
    return 1;
  }
  if (ident.indet.length) {
    for (const i of ident.indet) console.log(`[population-comparison] ? ${i}`);
    console.log('[population-comparison] a floor-declaring site could not be evaluated — that is not a pass');
    console.log(`POPULATION_COMPARISON_GATE_VERDICT=${INDET}`);
    return 3;
  }
  console.log('[population-comparison] every banned-comparator site is declared; debt within ratchet; ' +
              'every declared floor is identifiable');
  console.log(`POPULATION_COMPARISON_GATE_VERDICT=${PASS}`);
  return 0;
}

function selfTest() {
  const fails = [];
  const ck = (label, cond) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); if (!cond) fails.push(label); };

  // The banned shape matches the real forms found in this repo — built from the ACTUAL source
  // lines, not from hand-written approximations of them.
  ck('matches Math.max(alwaysBuyWr, alwaysSellWr, randomWr)',
     BANNED_SHAPE.test('  const bestBenchmark = Math.max(alwaysBuyWr, alwaysSellWr, randomWr);'));
  ck('matches actual - Math.max(alwaysBuy, alwaysSell)',
     BANNED_SHAPE.test('  return { edge: actual - Math.max(alwaysBuy, alwaysSell) };'));
  ck('matches Math.max(bench.alwaysBuyDwr, bench.alwaysSellDwr)',
     BANNED_SHAPE.test('  const benchmark = Math.max(bench.alwaysBuyDwr, bench.alwaysSellDwr);'));
  ck('matches the python form max(self.p_long, self.p_short) via always_ naming',
     BANNED_SHAPE.test('    best = max(always_long, always_short)'));
  ck('does NOT match an unrelated max',
     !BANNED_SHAPE.test('  const n = Math.max(a.length, b.length);'));
  ck('does NOT match a mix-matched null',
     !BANNED_SHAPE.test('  const pStar = q * pLong + (1 - q) * pShort;'));

  // A mention in a comment is not an invocation — and this is the trap that would otherwise
  // demand deleting the docblock that explains the historical buggy form.
  ck('a // comment mentioning the banned form is stripped',
     !BANNED_SHAPE.test(stripComments('// edge = actual - Math.max(alwaysBuy, alwaysSell)', 'x.ts')));
  ck('a # comment mentioning it is stripped',
     !BANNED_SHAPE.test(stripComments('# best = max(always_long, always_short)', 'x.py')));
  ck('a python docstring mentioning it is stripped',
     !BANNED_SHAPE.test(stripComments('"""uses max(always_long, always_short)"""', 'x.py')));
  ck('but real code on the same line as trailing prose still matches',
     BANNED_SHAPE.test(stripComments('const e = a - Math.max(alwaysBuy, alwaysSell); // note', 'x.ts')));

  // The corpus is real.
  let files = [];
  try { files = tracked(); } catch { /* ignore */ }
  ck(`the scan corpus is non-empty (${files.length} files)`, files.length > 100);

  // Contract coherence — the artifacts the run path reads but no scenario above exercises.
  let ok = false;
  try {
    const s = JSON.parse(readFileSync(SCHEMA, 'utf8'));
    const r = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    ok = s.banned_basis.includes('MAX_NAIVE')
      && r.sites.every(x => x.file && x.status)
      && r.sites.filter(x => x.status === 'UNMIGRATED').every(x => x.migration_wave)
      && Number.isFinite(Number(r.unmigrated_baseline));
  } catch (e) { console.log(`     (contract read failed: ${e.message})`); }
  ck('schema + registry are coherent: MAX_NAIVE banned, every site typed, every debt owned', ok);

  ck('the self-exclusion is EXACTLY this file — not an allowlist',
     SELF_EXCLUDED.size === 1 && SELF_EXCLUDED.has('scripts/check-population-comparison.mjs'));
  ck('the excluded file is genuinely absent from the swept corpus',
     !tracked().includes('scripts/check-population-comparison.mjs'));

  // ── Declaration-time identifiability, through the REAL python evaluator on the committed
  //    fixtures. Stubbing the evaluator here would leave the subprocess seam — the only place the
  //    bound is computed — exercised by no scenario at all.
  const fx = {};
  for (const name of ['trigger-a.site.json', 'valid.site.json']) {
    try { fx[name] = JSON.parse(readFileSync(join(IDENT_FIXTURES, name), 'utf8')); }
    catch (e) { console.log(`     (fixture ${name} unreadable: ${e.message})`); }
  }
  ck('both identifiability fixtures exist and parse (a corpus we construct may not be empty)',
     Object.keys(fx).length === 2);
  const trig = fx['trigger-a.site.json'];
  const valid = fx['valid.site.json'];
  const legA = identifiabilityLeg(trig ? [trig] : []);
  ck('trigger-A fixture (v1 minority share 0.0053, floor 3.0pp) is REFUSED at declaration: NOT_IDENTIFIABLE, 2m = 1.06pp',
     legA.refused === 1 && legA.indet.length === 0 &&
     legA.lines.some(l => /NOT_IDENTIFIABLE .*floor 3\.00pp vs 2m 1\.06pp/.test(l)));
  ck('…and it binds on the NARROWER arm (v1), not the wider v2',
     legA.lines.some(l => /narrowest arm: verdict_rule_version=1/.test(l)));
  const legV = identifiabilityLeg(valid ? [valid] : []);
  ck('valid fixture passes: evaluated, IDENTIFIABLE, nothing refused',
     legV.evaluated === 1 && legV.refused === 0 && legV.fails.length === 0 && legV.indet.length === 0);
  const base = valid ?? { id: 'x', declared_floor_pp: 1, sized_against: [{ arm: 'a', minority_side_share: 0.2, probe: 'cardinality probe' }] };
  const noShare = { ...base, id: 'x-floor-without-share' };
  delete noShare.sized_against;
  const noFloor = { ...base, id: 'x-share-without-floor' };
  delete noFloor.declared_floor_pp;
  const majority = { ...base, id: 'x-majority-share', sized_against: [{ ...base.sized_against[0], minority_side_share: 0.8 }] };
  const shapes = identifiabilityLeg([noShare, noFloor, majority]);
  ck('a floor without its share, a share without its floor, and a majority "minority" share are each refused as malformed',
     shapes.malformed === 3 && shapes.fails.length === 3 && shapes.evaluated === 0);
  const dark = identifiabilityLeg([base], join(ROOT, 'ops/monitoring/__absent_evaluator__.py'));
  ck('an evaluator that cannot run is INDETERMINATE — never a pass, never a refusal',
     dark.indet.length === 1 && dark.refused === 0 && dark.fails.length === 0);
  let liveIds = [];
  try { liveIds = JSON.parse(readFileSync(REGISTRY, 'utf8')).sites.map(s => s.id); } catch { /* ck below fails */ }
  ck('fixtures are not live sites: fixture:-prefixed, and the registry carries none',
     liveIds.length > 0 && [trig, valid].every(f => f && String(f.id).startsWith('fixture:')) &&
     !liveIds.some(id => String(id).startsWith('fixture:')));

  console.log(`SELF-TEST: ${fails.length === 0 ? 'PASS' : `FAIL (${fails.length})`}`);
  console.log(`POPULATION_COMPARISON_GATE_VERDICT=${fails.length === 0 ? PASS : INDET}`);
  return fails.length === 0 ? 0 : 3;
}

process.exit(process.argv.includes('--self-test') ? selfTest() : run());
