#!/usr/bin/env node
/**
 * check-footer-body-flow.mjs — DESIGN-WELCOME-LAYOUT-AND-FOOTER-FLOW-W1 R3.
 *
 * Asserts: no surface that renders the brand footer has a `body` rule which would make that
 * footer a FLEX/GRID SIBLING of the page content instead of a page footer.
 *
 * ── The bug class ───────────────────────────────────────────────────────────
 * `renderBrandFooter()` emits an element that assumes NORMAL DOCUMENT FLOW. On a page whose
 * `<body>` is `display:flex; justify-content:center` (a centering row), the footer becomes a
 * flex ITEM and renders BESIDE the card rather than beneath it. The architect reported it on
 * `/welcome`; measurement found `/contact` had it unreported, and this wave's own R0 found a
 * THIRD — `/signup`, which a live sweep skipped because it answered 400 without a ?plan param
 * while still rendering the whole page. _(That 400 was the DEFECT, not a property of the route:
 * `RELEASE-v1.28.0-AND-README-LINK-GATE-W1` CH1 flipped it to 200 — the bare page is the plan
 * picker, not an error. Recorded here because this comment is the earliest written evidence that
 * someone saw the 400 and filed it as a given; a live sweep no longer skips the route.)_
 *
 * Three pages, one root cause, and none of it was visible to any existing gate:
 * FOOTER-CONTACT-AND-UNIVERSAL-COVERAGE-W1's canary asserts the footer is PRESENT and matches
 * the SoT. Present and correctly placed are different claims, and it only checked the first.
 *
 * Design.md section 9 `chrome-injection-body-style-architecture-probe` already required probing
 * body styles before injecting footer chrome into a function-rendered page. The rule existed and
 * was not followed, so this encodes it as a gate rather than as prose.
 *
 * ── Why static and not Playwright ───────────────────────────────────────────
 * A rendered assertion would be stronger, but CLAUDE.md requires a playwright-page-fingerprint
 * artifact plus a chromium install for UI automation. This catches the whole class from source
 * at zero runtime cost. Pixel-level assertions, if ever needed, are DESIGN-RENDERED-LAYOUT-
 * CANARY-W{NEXT}.
 *
 *   node scripts/check-footer-body-flow.mjs             # gate
 *   node scripts/check-footer-body-flow.mjs --self-test # two-way, vacuity-guarded
 *
 * Codes: 0=PASS / 1=FAIL / 3=INDETERMINATE (token-law default for a NEW gate; do NOT "align" it
 * with check_test_baseline.sh's 2, which is 2 only because it already deployed 2).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SELF = url.fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');
const TOKEN = 'FOOTER_BODY_FLOW_VERDICT';
const CODES = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

const FOOTER_MARKER = 'data-av-brand-footer';
const FOOTER_FN = 'renderBrandFooter';

function verdict(v, why) {
  process.stdout.write(`${TOKEN}=${v}${why ? ` — ${why}` : ''}\n`);
  process.exit(CODES[v]);
}

/** Match a top-level `body { … }` rule. Not `.foo body`, not `.paywall-body`. */
const BODY_RULE = /(?<![\w.#-])body\s*\{([^}]*)\}/gi;

/**
 * Decide whether one `body` declaration block places a normal-flow footer as a sibling.
 * PURE + exported so the test suite asserts the RULE, not a re-implementation of it.
 *
 * @returns {{hazard: boolean, display: string|null, why: string}}
 */
export function classifyBodyRule(declaration) {
  const d = declaration.replace(/\s+/g, ' ').trim();
  const disp = /display\s*:\s*([\w-]+)/i.exec(d)?.[1]?.toLowerCase() ?? null;

  if (disp !== 'flex' && disp !== 'inline-flex' && disp !== 'grid' && disp !== 'inline-grid') {
    return { hazard: false, display: disp, why: 'body is in normal flow' };
  }

  if (disp === 'flex' || disp === 'inline-flex') {
    const dir = /flex-direction\s*:\s*([\w-]+)/i.exec(d)?.[1]?.toLowerCase() ?? 'row';
    if (dir.startsWith('column')) {
      return { hazard: false, display: disp, why: `flex column — footer stacks last (${dir})` };
    }
    return {
      hazard: true,
      display: disp,
      why: `body is a flex ROW (flex-direction: ${dir}) — the footer becomes a flex ITEM beside the content. Fix the CONTAINER: flex-direction:column + a <main> that does the centering. Never special-case the footer's own CSS.`,
    };
  }

  // Grid: safe only if the last child is explicitly placed full-width. We cannot resolve that
  // statically with confidence, so a grid body is a hazard unless it declares a single column.
  const cols = /grid-template-columns\s*:\s*([^;]+)/i.exec(d)?.[1]?.trim().toLowerCase() ?? null;
  if (cols && /^(1fr|100%|minmax\([^)]*\))$/.test(cols.replace(/\s+/g, ''))) {
    return { hazard: false, display: disp, why: `single-column grid (${cols}) — footer spans` };
  }
  return {
    hazard: true,
    display: disp,
    why: `body is a grid with no single-column track (${cols ?? 'no grid-template-columns'}) — the footer lands in a cell rather than spanning. Declare a single column, or use the flex-column + <main> shape.`,
  };
}

/**
 * Enumerate every surface that can carry the brand footer, with its body rules.
 * @returns {{status:'PASS'|'INDETERMINATE', surfaces:Array, why?:string}}
 */
export function collectSurfaces(root) {
  let files;
  try {
    files = [
      ...globSync('src/**/*.ts', { cwd: root }),
      ...globSync('landing/**/*.html', { cwd: root }),
    ];
  } catch (e) {
    return { status: 'INDETERMINATE', surfaces: [], why: `glob failed: ${e.message}` };
  }

  const surfaces = [];
  for (const rel of files.map((p) => p.split(path.sep).join('/')).sort()) {
    let src;
    try {
      src = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    // A surface is in scope only if it actually carries the footer.
    const carries = rel.endsWith('.ts') ? src.includes(FOOTER_FN) : src.includes(FOOTER_MARKER);
    if (!carries) continue;
    // The SoT module itself defines the footer; it renders no page.
    if (rel === 'src/lib/footer-content.ts') continue;

    // Strip comments FIRST — Design.md section 10 comment-vs-rendered-DOM-aware-canary. This
    // wave's own probe tripped on its own explanatory comment naming renderBrandFooter().
    const clean = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

    const rules = [...clean.matchAll(BODY_RULE)];
    if (rules.length === 0) {
      surfaces.push({ rel, display: null, hazard: false, why: 'no body rule — normal flow' });
      continue;
    }
    for (const m of rules) surfaces.push({ rel, ...classifyBodyRule(m[1]) });
  }

  if (surfaces.length === 0) {
    return {
      status: 'INDETERMINATE',
      surfaces: [],
      why: 'ZERO footer-bearing surfaces found — this repo has many, so the scan is broken',
    };
  }
  return { status: 'PASS', surfaces };
}

// ──────────────────────────────────── main ───────────────────────────────────

function main(argv) {
  const rootIdx = argv.indexOf('--root');
  const root = rootIdx === -1 ? REPO_ROOT : path.resolve(argv[rootIdx + 1] || '.');

  const { status, surfaces, why } = collectSurfaces(root);
  if (status !== 'PASS') verdict(status, why);

  const hazards = surfaces.filter((s) => s.hazard);
  const scanned = new Set(surfaces.map((s) => s.rel)).size;

  for (const h of hazards) console.error(`[footer-body-flow] HAZARD ${h.rel}\n    ${h.why}`);

  if (hazards.length > 0) {
    verdict('FAIL', `${hazards.length} footer-bearing surface(s) would render the footer as a sibling, across ${scanned} scanned`);
  }
  // Positive per-surface output: an absence of complaints must not be the only evidence.
  console.log(`[footer-body-flow] ${scanned} footer-bearing surface(s) verified in normal flow.`);
  verdict('PASS', `${scanned} surface(s) place the brand footer below page content`);
}

// ───────────────────────────────── self-test ─────────────────────────────────

function selfTest() {
  const fails = [];
  let produce = 0;
  let refuse = 0;
  let map = 0;
  const EXPECTED_CODES = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'footer-body-flow.'));
  const mkRoot = (name, files) => {
    const r = path.join(tmp, name);
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(r, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    }
    return r;
  };
  const run = (root) => {
    const r = spawnSync(process.execPath, [SELF, '--root', root], { encoding: 'utf8' });
    const line = ((r.stdout || '') + (r.stderr || '')).split('\n').find((l) => l.startsWith(`${TOKEN}=`)) || '';
    return { token: line.split('=')[1]?.split(' ')[0] || '', code: r.status ?? -1 };
  };
  const expect = (label, got, want) => {
    if (got !== want) fails.push(`${label}: expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
  };
  const expectVerdict = (label, r, token) => {
    expect(`${label} token`, r.token, token);
    expect(`${label} code`, r.code, EXPECTED_CODES[token]);
  };
  const page = (css, marker = true) =>
    `<html><head><style>${css}</style></head><body>${marker ? '<footer data-av-brand-footer="desktop">x</footer>' : ''}</body></html>`;

  try {
    // ── must-refuse: the exact shape that produced all three live defects ────
    refuse += 1;
    expectVerdict(
      'centering flex row FAILS',
      run(mkRoot('flexrow', { 'landing/a.html': page('body { display:flex; justify-content:center; align-items:center; min-height:100vh }') })),
      'FAIL',
    );

    refuse += 1;
    expectVerdict(
      'flex row in a .ts renderer FAILS',
      run(mkRoot('flexts', { 'src/lib/p.ts': `export const x = \`<style>body { display: flex; justify-content: center; }</style>\`; ${FOOTER_FN}('desktop');` })),
      'FAIL',
    );

    refuse += 1;
    expectVerdict(
      'multi-column grid FAILS',
      run(mkRoot('grid', { 'landing/a.html': page('body { display:grid; grid-template-columns: 1fr 1fr }') })),
      'FAIL',
    );

    refuse += 1;
    expectVerdict('no footer-bearing surface at all ⇒ INDETERMINATE (vacuity)', run(mkRoot('empty', { 'landing/a.html': page('body{margin:0}', false) })), 'INDETERMINATE');

    // ── must-produce: the three shapes that are genuinely correct ───────────
    produce += 1;
    expectVerdict('flex COLUMN passes (this wave\'s fix)', run(mkRoot('col', { 'landing/a.html': page('body { display:flex; flex-direction:column; min-height:100vh }') })), 'PASS');

    produce += 1;
    expectVerdict('normal-flow body passes', run(mkRoot('flow', { 'landing/a.html': page('body { margin:0; background:#000 }') })), 'PASS');

    produce += 1;
    expectVerdict('single-column grid passes', run(mkRoot('grid1', { 'landing/a.html': page('body { display:grid; grid-template-columns: 1fr }') })), 'PASS');

    // ── must-map ────────────────────────────────────────────────────────────
    map += 1;
    // The SoT module is excluded — it defines the footer, it renders no page.
    expectVerdict('footer-content.ts itself is not a surface', run(mkRoot('sot', {
      'src/lib/footer-content.ts': `body { display:flex } ${FOOTER_FN}`,
      'landing/a.html': page('body{margin:0}'),
    })), 'PASS');

    map += 1;
    // Comment-stripping: a flex body quoted INSIDE a comment must not trip the gate.
    expectVerdict('flex body quoted in a comment does not trip it', run(mkRoot('cmt', {
      'landing/a.html': `<html><head><style>/* was body { display:flex; justify-content:center } before the fix */
        body { margin: 0 }</style></head><body><footer data-av-brand-footer="desktop">x</footer></body></html>`,
    })), 'PASS');

    map += 1;
    // A page with no footer is out of scope even if its body is a flex row.
    expectVerdict('flex row WITHOUT a footer is out of scope', run(mkRoot('nofoot', {
      'landing/a.html': page('body { display:flex; justify-content:center }', false),
      'landing/b.html': page('body { margin:0 }'),
    })), 'PASS');

    map += 1;
    expect('classifyBodyRule is pure/importable', classifyBodyRule('display:flex; justify-content:center').hazard, true);
    map += 1;
    expect('classifyBodyRule column is safe', classifyBodyRule('display:flex; flex-direction:column').hazard, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (produce === 0 || refuse === 0 || map === 0) {
    process.stdout.write(`${TOKEN}=INDETERMINATE — self-test VACUOUS: ${produce} must-produce, ${refuse} must-refuse, ${map} must-map\n`);
    process.exit(CODES.INDETERMINATE);
  }
  if (fails.length) {
    process.stdout.write(`${TOKEN}=FAIL — self-test ${fails.length} failure(s): ${fails.join(' | ')}\n`);
    process.exit(CODES.FAIL);
  }
  process.stdout.write(`${TOKEN}=PASS — self-test ${produce} must-produce, ${refuse} must-refuse, ${map} must-map\n`);
  process.exit(CODES.PASS);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) selfTest();
  else main(argv);
}
