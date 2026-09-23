/**
 * DESIGN-THEME-UNIVERSAL-COVERAGE-W1 R3/R5 — the page scaffold.
 *
 * R1 and R2 DETECT an off-theme page. This is the BY-CONSTRUCTION half: the emitted page already
 * carries the canonical loader, the four generated marker pairs, `body { background: var(--bg) }`
 * and ZERO colour literals, so the default path is the compliant one.
 *
 * WHAT THIS SUITE IS ACTUALLY DEFENDING, beyond "it renders":
 *
 *  - BYTE-STABILITY of --dry-run, because a scaffold whose output shifts between runs cannot be
 *    reviewed before it is written.
 *  - ESCAPING, because --title and --description land inside meta attributes and <title> on a
 *    public page; an unescaped quote there is a broken tag, not a cosmetic slip.
 *  - REFUSALS, including a slug carrying a path separator — the scaffold writes a file at a
 *    caller-supplied name.
 *  - REGION BLANKING. The committed templates carry FILLED regions (they must, or build_theme
 *    --check reports them drifted), so copying them verbatim would hand a new page a SNAPSHOT of
 *    the region as it stood when the template was last written.
 *  - THE INHERITED-DEBT PATH for --kind answer, asserted in BOTH directions: the ratchet must
 *    refuse the inherited literals, and the documented --allow-raise must be what clears them.
 *    Only one of those halves failing would leave the escape hatch rotting unnoticed.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  REPO_ROOT,
  SLUG_RE,
  TEMPLATES,
  BLANK_REGIONS,
  attr,
  text,
  blankRegions,
  stripAuthoringDocblock,
  renderPage,
  planPage,
  loaderDrift,
  lastToken,
  INJECTORS,
} from '../../scripts/new-landing-page.mjs';
import { countLiterals } from '../../scripts/check-colour-literal-ratchet.mjs';
import { THEME_START, THEME_END, LOADER_LINK, isCovered } from '../../scripts/build_theme.mjs';

const SKELETON = fs.readFileSync(path.join(REPO_ROOT, TEMPLATES.page), 'utf8');
const ARGS = { slug: 'zz-probe', title: 'Probe', description: 'Probe description' };

describe('the committed skeleton', () => {
  it('is a covered page in its own right (R1 target, carries markers + loader)', () => {
    expect(isCovered(SKELETON)).toBe(true);
  });

  it('carries the canonical loader block BYTE-IDENTICALLY', () => {
    expect(loaderDrift(REPO_ROOT, TEMPLATES.page)).toBe('');
  });

  it('so does the answer template', () => {
    expect(loaderDrift(REPO_ROOT, TEMPLATES.answer)).toBe('');
  });

  // The two kinds do NOT carry the same marker set, and that is the family design rather than
  // drift: the answer-page family renders its own sticky <nav> inline (0 of its 16 live pages
  // carry NAV markers, measured 2026-09-23) and is correspondingly not nav-bearing to build_nav.
  // Asserting one shared set would either red a correct template or bless a missing region.
  it.each([
    ['page', TEMPLATES.page, ['THEME', 'NAV', 'ANALYTICS']],
    ['answer', TEMPLATES.answer, ['THEME', 'ANALYTICS']],
  ] as const)('the %s template carries every marker pair its injectors fill', (_kind, rel, names) => {
    const html = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const present = names.flatMap((name) => [
      html.includes(`<!-- ${name}:START -->`) ? `${name}:START` : `${name}:START MISSING`,
      html.includes(`<!-- ${name}:END -->`) ? `${name}:END` : `${name}:END MISSING`,
    ]);
    expect(present).toEqual(names.flatMap((n) => [`${n}:START`, `${n}:END`]));
    expect(/<footer\b[^>]*data-av-brand-footer/.test(html)).toBe(true);
  });

  it('the answer template carries an ANALYTICS region — it had none before R3, and the family all do', () => {
    const tpl = fs.readFileSync(path.join(REPO_ROOT, TEMPLATES.answer), 'utf8');
    expect(tpl).toContain('<!-- ANALYTICS:START -->');
    // The family it is the template FOR. landing/_templates/ is excluded from build_analytics by
    // the leading-underscore rule, so the template could drift from its own output in silence.
    const family = fs
      .readdirSync(path.join(REPO_ROOT, 'landing'))
      .filter((f) => f.endsWith('.html'))
      .map((f) => fs.readFileSync(path.join(REPO_ROOT, 'landing', f), 'utf8'))
      .filter((h) => h.includes('<nav style="position:sticky;top:0;z-index:20;'));
    expect(family.length).toBeGreaterThan(0);
    expect(family.every((h) => h.includes('<!-- ANALYTICS:START -->'))).toBe(true);
  });

  it('paints its background from a token and owns ZERO colour literals', () => {
    expect(SKELETON).toContain('background: var(--bg)');
    // Zero of ITS OWN. The committed file also carries the FILLED theme and nav regions (it has
    // to, or build_theme --check reports it drifted), and those bytes belong to
    // src/lib/site-theme.ts and src/lib/site-nav.ts. renderPage blanks them on the way out,
    // which is why the EMITTED page is literal-free under a raw grep and this file is not.
    expect(countLiterals(SKELETON)).toBe(0);
    expect(renderPage(SKELETON, ARGS).match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)).toBeNull();
  });
});

describe('renderPage — pure, byte-stable, escaped', () => {
  it('is byte-stable across runs (this is what makes --dry-run reviewable)', () => {
    expect(renderPage(SKELETON, ARGS)).toBe(renderPage(SKELETON, ARGS));
  });

  it('starts the page at <!DOCTYPE and drops the template authoring docblock', () => {
    const out = renderPage(SKELETON, ARGS);
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(out).not.toContain('DO NOT COPY THIS FILE BY HAND');
    // Not vacuous: the template really does carry it.
    expect(SKELETON).toContain('DO NOT COPY THIS FILE BY HAND');
  });

  it('substitutes title, description and slug, leaving no head SLOT marker behind', () => {
    const out = renderPage(SKELETON, ARGS);
    expect(out).toContain('<title>Probe</title>');
    expect(out).toContain('content="Probe description"');
    expect(out).toContain('href="https://algovault.com/zz-probe"');
    expect(/<!--\s*SLOT:(TITLE|META_DESC|SLUG|OG_TITLE|OG_DESC)\s*-->/.test(out)).toBe(false);
  });

  it('emits exactly one of each marker pair, blanked', () => {
    const out = renderPage(SKELETON, ARGS);
    for (const name of ['THEME', 'NAV', 'ANALYTICS']) {
      expect((out.match(new RegExp(`<!-- ${name}:START -->`, 'g')) || []).length).toBe(1);
      expect(out).toContain(`<!-- ${name}:START -->\n<!-- ${name}:END -->`);
    }
    expect(out).toContain(`${THEME_START}\n${THEME_END}`);
  });

  it('blankRegions empties a FILLED region rather than appending a second pair', () => {
    const filled = '<!-- NAV:START -->\n<nav>lots of bytes</nav>\n<!-- NAV:END -->';
    const out = blankRegions(filled);
    expect(out).toBe('<!-- NAV:START -->\n<!-- NAV:END -->');
    expect((out.match(/<!-- NAV:START -->/g) || []).length).toBe(1);
  });

  it('blanks every declared region kind', () => {
    for (const name of BLANK_REGIONS) {
      expect(blankRegions(`<!-- ${name}:START -->junk<!-- ${name}:END -->`)).toBe(`<!-- ${name}:START -->\n<!-- ${name}:END -->`);
    }
  });

  it('keeps the design loader and the token background', () => {
    const out = renderPage(SKELETON, ARGS);
    expect(out).toContain(LOADER_LINK);
    expect(out).toContain('background: var(--bg)');
  });

  it('emits ZERO colour literals — AC3 greps the raw bytes', () => {
    expect(renderPage(SKELETON, ARGS).match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)).toBeNull();
  });

  it.each([
    ['a quote in --title lands escaped in an attribute', { ...ARGS, title: 'A "quoted" title' }, 'content="A &quot;quoted&quot; title"'],
    ['markup in --title lands escaped in <title>', { ...ARGS, title: '<b>x</b>' }, '<title>&lt;b&gt;x&lt;/b&gt;</title>'],
    ['an ampersand in --description lands escaped', { ...ARGS, description: 'x & y' }, 'content="x &amp; y"'],
  ])('MUST-ESCAPE: %s', (_label, args, needle) => {
    expect(renderPage(SKELETON, args)).toContain(needle);
  });

  it('attr() and text() escape the characters that break their context', () => {
    expect(attr('a"b<c>d&e')).toBe('a&quot;b&lt;c&gt;d&amp;e');
    expect(text('a"b<c>d&e')).toBe('a"b&lt;c&gt;d&amp;e');
  });

  it('stripAuthoringDocblock leaves a file that has no docblock alone', () => {
    expect(stripAuthoringDocblock('<!DOCTYPE html><html></html>')).toBe('<!DOCTYPE html><html></html>');
  });
});

describe('planPage — refusals', () => {
  it.each([
    ['a missing --slug', ['--title', 'T', '--description', 'D']],
    ['an upper-case slug', ['--slug', 'Bad-Slug', '--title', 'T', '--description', 'D']],
    ['a slug with a path separator', ['--slug', '../etc/passwd', '--title', 'T', '--description', 'D']],
    ['a slug with a dot', ['--slug', 'a.b', '--title', 'T', '--description', 'D']],
    ['a missing --title', ['--slug', 'ok', '--description', 'D']],
    ['a missing --description', ['--slug', 'ok', '--title', 'T']],
    ['an unknown --kind', ['--slug', 'ok', '--title', 'T', '--description', 'D', '--kind', 'poster']],
    ['an existing page', ['--slug', 'privacy', '--title', 'T', '--description', 'D']],
  ])('MUST-REFUSE %s', (_label, argv) => {
    expect(planPage(argv, REPO_ROOT).ok).toBe(false);
  });

  it('reports EVERY problem at once, not one per run', () => {
    const r = planPage(['--slug', 'Bad Slug'], REPO_ROOT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why.length).toBeGreaterThanOrEqual(3);
  });

  it('MUST-PASS a well-formed request, defaulting to the page kind', () => {
    const r = planPage(['--slug', 'zz-probe', '--title', 'T', '--description', 'D'], REPO_ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.plan.kind, r.plan.outRel]).toEqual(['page', path.join('landing', 'zz-probe.html')]);
  });

  it('accepts --kind answer', () => {
    const r = planPage(['--slug', 'zz-probe', '--title', 'T', '--description', 'D', '--kind', 'answer'], REPO_ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.templateRel).toBe(TEMPLATES.answer);
  });

  it('SLUG_RE is the URL contract, not a formality', () => {
    for (const ok of ['a', 'a-b', 'trade-calls-2026']) expect(SLUG_RE.test(ok)).toBe(true);
    for (const bad of ['A', 'a_b', 'a/b', 'a.b', 'a b', '']) expect(SLUG_RE.test(bad)).toBe(false);
  });

  it('loaderDrift REPORTS when a template stops carrying the canonical block', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-drift-'));
    try {
      fs.mkdirSync(path.join(root, 'landing', '_design'), { recursive: true });
      fs.mkdirSync(path.join(root, 'landing', '_templates'), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, 'landing', '_design', 'loader-snippet.html'), path.join(root, 'landing', '_design', 'loader-snippet.html'));
      fs.writeFileSync(path.join(root, TEMPLATES.page), '<!DOCTYPE html><html><head></head><body></body></html>');
      expect(loaderDrift(root, TEMPLATES.page)).toMatch(/byte-identically/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('lastToken — callers gate on the TOKEN, never the bare exit code', () => {
  it('reads the terminal token line', () => {
    expect(lastToken('noise\nTHEME_SYNC_VERDICT=PASS\n', 'THEME_SYNC_VERDICT')).toBe('PASS');
  });

  it('takes the LAST one when a run printed several (a chained --self-test then --check)', () => {
    expect(lastToken('X_VERDICT=PASS\nX_VERDICT=FAIL\n', 'X_VERDICT')).toBe('FAIL');
  });

  it('returns empty when the gate printed no token at all — never a silent pass', () => {
    expect(lastToken('it crashed', 'X_VERDICT')).toBe('');
  });

  it('every injector in the chain names a real script', () => {
    for (const inj of INJECTORS) expect(fs.existsSync(path.join(REPO_ROOT, inj.script))).toBe(true);
  });
});

describe('the scaffold end to end', () => {
  // Spawns a process, so it owns its budget (scripts/check-test-budget.mjs): the self-test
  // copies landing/ into two temp roots and drives five injectors and two gates over each.
  it('--self-test PASSES for both kinds, proving the whole chain in a temp root', { timeout: 180_000 }, () => {
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'new-landing-page.mjs'), '--self-test'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    expect(lastToken(out, 'NEW_LANDING_PAGE_SELFTEST_VERDICT'), out.split('\n').filter((l) => l.includes('FAIL')).join('\n')).toBe('PASS');
    expect(r.status).toBe(0);
  });

  it('--dry-run output is byte-identical to renderPage and leaks no file', { timeout: 60_000 }, () => {
    const r = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts', 'new-landing-page.mjs'), '--slug', 'zz-scaffold-probe', '--title', 'Probe', '--description', 'Probe', '--dry-run'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(renderPage(SKELETON, { slug: 'zz-scaffold-probe', title: 'Probe', description: 'Probe' }));
    expect(fs.existsSync(path.join(REPO_ROOT, 'landing', 'zz-scaffold-probe.html'))).toBe(false);
  });

  it('MUST-REFUSE an invalid request with a FAIL token and a non-zero exit', { timeout: 60_000 }, () => {
    const r = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts', 'new-landing-page.mjs'), '--slug', 'Bad Slug', '--title', 'T', '--description', 'D', '--dry-run'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(lastToken(`${r.stdout}${r.stderr}`, 'NEW_LANDING_PAGE_VERDICT')).toBe('FAIL');
    expect(r.status).toBe(1);
  });
});
