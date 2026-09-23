/**
 * DESIGN-THEME-UNIVERSAL-COVERAGE-W1 R2/R5 — the colour-literal RATCHET.
 *
 * THE GAP THIS CLOSES. check-legacy-navy-literals.mjs fails closed on NINE named literals. A new
 * page painting #111827 or rgb(17,24,39) is invisible to it, and the corpus still carries ~860
 * hand-written literals — a zero-tolerance gate is not shippable, a ratchet is.
 *
 * TWO PROPERTIES THIS SUITE DEFENDS, because mutation testing showed both can rot silently:
 *
 *  1. THE COUNTING RULE IS CONTEXT-SCOPED. A literal counts only where it PAINTS — in a <style>
 *     block, a style="" attribute, or a `-[#…]` arbitrary utility. Bytes a GENERATOR writes into
 *     a marked region belong to that generator's SoT module, not to the 58 pages that host it;
 *     billing them per-page measures the generator's reach and makes every scaffolded page start
 *     in the red through no fault of its own.
 *  2. THE ONLY WAY UP IS A DATA FILE. --write-baseline lowers and never raises; --allow-raise
 *     demands a substantive --reason and records it with the date.
 *
 * Several legs below carry an explicit "…and the same bytes outside the exclusion ARE counted"
 * twin. That is not belt-and-braces: two earlier drafts of the ld+json leg passed while the
 * exclusion was deleted, because the fixture scored 0 either way.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  REPO_ROOT,
  BASELINE_REL,
  PRODUCERS,
  countLiterals,
  corpusFiles,
  measure,
  compare,
  lowerOnly,
  planRaise,
  evaluate,
  selfTest,
} from '../../scripts/check-colour-literal-ratchet.mjs';

describe('the counting rule', () => {
  it.each([
    ['a hex in a <style> block', '<style>body { color: #112233; }</style>', 1],
    ['a hex in a double-quoted style attribute', '<p style="color:#abc">x</p>', 1],
    ['a hex in a single-quoted style attribute', "<p style='color:#abcdef'>x</p>", 1],
    ['rgb() + rgba() + hsl()', '<style>a{color:rgb(1,2,3);background:rgba(1,2,3,.5);border-color:hsl(1,2%,3%)}</style>', 3],
    ['Tailwind arbitrary colour utilities', '<div class="bg-[#123456] text-[#fff]"></div>', 2],
  ])('counts %s', (_label, html, want) => {
    expect(countLiterals(html)).toBe(want);
  });

  it.each([
    ['a literal outside any paint context', "<script>tailwind.config={colors:{steel:{400:'#8b9bb5'}}}</script>"],
    ['an HTML comment', '<!-- <style>a{color:#112233}</style> -->'],
    ['a CSS comment inside a <style> block', '<style>/* was #112233 */ a{color:var(--fg)}</style>'],
    ['a JS line comment', 'const x = 1; // style="color:#112233"'],
    ['a var() token', '<style>body { background: var(--bg); color: var(--fg-2); }</style>'],
    ['an oklch() channel reference', '<nav style="background:oklch(var(--bg-lch, 0.16 0.012 265) / 0.85)"></nav>'],
  ])('ignores %s', (_label, html) => {
    expect(countLiterals(html)).toBe(0);
  });

  it('a URL is not a line comment (a naive //.*$ eats half this corpus)', () => {
    expect(countLiterals('<a href="https://x.test/" style="color:#112233">y</a>')).toBe(1);
  });

  describe('generated regions belong to their SoT module, not the page', () => {
    const SHADOW = '<div style="box-shadow:0 20px 60px -12px rgba(0,0,0,0.7)"></div>';

    it.each([
      ['a NAV region', `<!-- NAV:START -->${SHADOW}<!-- NAV:END -->`],
      ['a THEME region', '<!-- THEME:START --><style>a{color:#112233}</style><!-- THEME:END -->'],
      ['an ANALYTICS region', '<!-- ANALYTICS:START --><style>a{color:#112233}</style><!-- ANALYTICS:END -->'],
      ['the brand-footer element', '<footer data-av-brand-footer="desktop" style="color:#112233"></footer>'],
      ['an ld+json body', `<script type="application/ld+json">{"articleBody":"<p style='color:#112233'>x</p>"}</script>`],
    ])('ignores %s', (_label, html) => {
      expect(countLiterals(html)).toBe(0);
    });

    it.each([
      ['the nav shadow', SHADOW, 1],
      ['the ld+json body bytes', `{"articleBody":"<p style='color:#112233'>x</p>"}`, 1],
    ])('…but counts %s outside the exclusion (so the legs above are not vacuous)', (_label, html, want) => {
      expect(countLiterals(html)).toBe(want);
    });

    it("a page's own markup after a generated region is still counted", () => {
      expect(countLiterals(`<!-- NAV:START -->${SHADOW}<!-- NAV:END --><p style="color:#112233">x</p>`)).toBe(1);
    });
  });
});

describe('the ratchet direction', () => {
  it('MUST-CATCH a count over baseline', () => {
    const { over, under } = compare({ 'landing/faq.html': 4 }, { 'landing/faq.html': 3 });
    expect(over.map((o) => o.path)).toEqual(['landing/faq.html']);
    expect(under).toEqual([]);
  });

  it('MUST-CATCH a NEW file with one literal and no baseline row', () => {
    const { over } = compare({ 'landing/brand-new.html': 1 }, { 'landing/faq.html': 3 });
    expect(over).toEqual([{ path: 'landing/brand-new.html', count: 1, baseline: 0 }]);
  });

  it('MUST-PASS an UNCHANGED count — the >= boundary a mutant walked straight through', () => {
    const { over, under } = compare({ 'landing/faq.html': 3 }, { 'landing/faq.html': 3 });
    expect([over, under]).toEqual([[], []]);
  });

  it('MUST-PASS a lowered count, and report it as a tightening', () => {
    const { over, under } = compare({ 'landing/faq.html': 1 }, { 'landing/faq.html': 3 });
    expect(over).toEqual([]);
    expect(under.map((u) => u.path)).toEqual(['landing/faq.html']);
  });

  it('MUST-PASS a clean new file with no row', () => {
    expect(compare({ 'landing/clean.html': 0 }, {})).toEqual({ over: [], under: [] });
  });

  it('orders offenders by how far over they are, then by path (never iteration order)', () => {
    const { over } = compare({ 'a.html': 5, 'b.html': 20, 'c.html': 6 }, { 'a.html': 1, 'b.html': 1, 'c.html': 1 });
    expect(over.map((o) => o.path)).toEqual(['b.html', 'c.html', 'a.html']);
  });
});

describe('--write-baseline lowers, and only lowers', () => {
  it('lowers a row and locks the gain in', () => {
    expect(lowerOnly({ 'landing/faq.html': 1 }, { 'landing/faq.html': 3 }).next['landing/faq.html']).toBe(1);
  });

  it('MUST-REFUSE a raise — that is what --allow-raise is for', () => {
    const r = lowerOnly({ 'landing/faq.html': 9 }, { 'landing/faq.html': 3 });
    expect(r.next['landing/faq.html']).toBe(3);
    expect(r.refused.map((x) => x.path)).toEqual(['landing/faq.html']);
  });

  it('gives a clean new file its 0 row', () => {
    expect(lowerOnly({ 'landing/new.html': 0 }, {}).next['landing/new.html']).toBe(0);
  });

  it('drops a row whose file has left the corpus, so it cannot resurrect an allowance', () => {
    const r = lowerOnly({ 'landing/faq.html': 1 }, { 'landing/faq.html': 3, 'landing/deleted.html': 7 });
    expect('landing/deleted.html' in r.next).toBe(false);
  });

  it('--seed is the one-time bootstrap, and it is a separate act on purpose', () => {
    expect(lowerOnly({ 'landing/faq.html': 9 }, {}, { seed: true }).next['landing/faq.html']).toBe(9);
    expect(lowerOnly({ 'landing/faq.html': 9 }, {}).refused.map((x) => x.path)).toEqual(['landing/faq.html']);
  });
});

describe('--allow-raise is the only way up, and it demands an argument', () => {
  const current = { 'landing/faq.html': 5 };
  const baseline = { 'landing/faq.html': 3 };
  const args = { target: 'landing/faq.html', current, baseline, today: '2026-09-23' };

  it.each([
    ['no --reason', { reason: undefined }],
    ['a token --reason', { reason: 'wip' }],
    ['a path outside the corpus', { target: 'landing/nope.html', reason: 'a properly stated reason' }],
    ['a "raise" that does not raise', { current: { 'landing/faq.html': 3 }, reason: 'a properly stated reason' }],
  ])('MUST-REFUSE %s', (_label, over) => {
    expect(planRaise({ ...args, ...over }).ok).toBe(false);
  });

  it('records path / from / to / reason / date on a reasoned raise', () => {
    const r = planRaise({ ...args, reason: 'inherited verbatim from a baselined template' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row).toEqual({ path: 'landing/faq.html', from: 3, to: 5, reason: 'inherited verbatim from a baselined template', date: '2026-09-23' });
  });
});

describe('the corpus derivation', () => {
  it('covers landing, docs-src and every named producer', () => {
    const files = corpusFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.startsWith('landing/') && f.endsWith('.html'))).toBe(true);
    expect(files.some((f) => f.startsWith('docs-src/'))).toBe(true);
    for (const p of PRODUCERS) expect(files).toContain(p);
  });

  it('EXCLUDES this gate and the retirement sweeps — a gate that scans itself reports its own fixtures', () => {
    const files = corpusFiles(REPO_ROOT);
    expect(files).not.toContain('scripts/check-colour-literal-ratchet.mjs');
    expect(files).not.toContain('scripts/check-legacy-navy-literals.mjs');
    expect(files).not.toContain('scripts/sweep-answer-page-css.mjs');
  });

  it('is sorted, so the answer is a function of the file set and never of directory order', () => {
    const files = corpusFiles(REPO_ROOT);
    expect(files).toEqual([...files].sort());
  });
});

describe('the committed baseline and the live verdict', () => {
  it("the script's own self-test passes (it gates the gate)", () => {
    const log = console.log;
    console.log = () => {};
    try {
      expect(selfTest()).toBe(0);
    } finally {
      console.log = log;
    }
  });

  it('the live tree PASSES against the committed baseline', () => {
    const live = evaluate(REPO_ROOT);
    expect(live.verdict).toBe('PASS');
    expect(live.over).toEqual([]);
  });

  it('every corpus file has a baseline row, so nothing is silently unmeasured', () => {
    const baseline = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, BASELINE_REL), 'utf8')).counts;
    for (const f of Object.keys(measure(REPO_ROOT))) expect(baseline).toHaveProperty([f]);
  });

  it('the page skeleton is baselined at ZERO — a page born from it starts clean', () => {
    const baseline = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, BASELINE_REL), 'utf8')).counts;
    expect(baseline['landing/_templates/page.template.html']).toBe(0);
  });

  it('every recorded raise carries a substantive reason and a date', () => {
    const raises = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, BASELINE_REL), 'utf8')).raises;
    expect(Array.isArray(raises)).toBe(true);
    for (const r of raises) {
      expect(r.reason.trim().length).toBeGreaterThanOrEqual(10);
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.to).toBeGreaterThan(r.from);
    }
  });

  it('AC2 — one extra #111827 in a temp-root copy of landing/faq.html FAILS, naming it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-ac2-'));
    try {
      fs.mkdirSync(path.join(root, 'landing'), { recursive: true });
      fs.mkdirSync(path.join(root, 'ops'), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, 'landing', 'faq.html'), path.join(root, 'landing', 'faq.html'));
      const committed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, BASELINE_REL), 'utf8')).counts;
      const before = committed['landing/faq.html'];
      fs.writeFileSync(
        path.join(root, BASELINE_REL),
        JSON.stringify({ counts: { 'landing/faq.html': before }, raises: [] }),
      );
      expect(evaluate(root).verdict).toBe('PASS'); // the control

      const p = path.join(root, 'landing', 'faq.html');
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('</head>', '<style>.x{color:#111827}</style></head>'));
      const after = evaluate(root);
      expect(after.verdict).toBe('FAIL');
      expect(after.over).toEqual([{ path: 'landing/faq.html', count: before + 1, baseline: before }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a missing or malformed baseline is INDETERMINATE, never a quiet pass', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-ind-'));
    try {
      fs.mkdirSync(path.join(root, 'landing'), { recursive: true });
      fs.mkdirSync(path.join(root, 'ops'), { recursive: true });
      fs.writeFileSync(path.join(root, 'landing', 'x.html'), '<p>x</p>');
      expect(evaluate(root).verdict).toBe('INDETERMINATE');
      fs.writeFileSync(path.join(root, BASELINE_REL), '{ not json');
      expect(evaluate(root).verdict).toBe('INDETERMINATE');
      fs.writeFileSync(path.join(root, BASELINE_REL), JSON.stringify({ counts: {} }));
      expect(evaluate(root).verdict).toBe('INDETERMINATE'); // no raises[]
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('an EMPTY corpus is INDETERMINATE — this repo authors these pages', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-empty-'));
    try {
      expect(evaluate(root).verdict).toBe('INDETERMINATE');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
