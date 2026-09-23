/**
 * DESIGN-THEME-UNIVERSAL-COVERAGE-W1 R1/R5 — the theme-region COVERAGE leg.
 *
 * THE GAP THIS CLOSES. `build_theme --check` used to flag a page only when it carried a Tailwind
 * signature OUTSIDE the markers, or when a MARKED page had dropped the design stylesheet. A page
 * with neither — no Tailwind, no markers, just a hand-written <style> block in whatever colours
 * its author liked — hit `if (!outside) continue` in the region writer's loop and was never seen
 * by any gate. This suite pins the positive per-page assertion that replaces that silence, and it
 * pins BOTH directions: a page must be covered, and an exemption must still earn its row.
 *
 * Every assertion runs against a temp root carrying a real ops/theme-coverage-config.json, so the
 * config LOADER is exercised rather than stubbed — the seam a hermetic suite is otherwise blind to.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  THEME_START,
  THEME_END,
  LOADER_LINK,
  LOADER_END,
  COVERAGE_CONFIG_REL,
  REPO_ROOT,
  loadCoverageConfig,
  deriveCoverageTargets,
  coverageAudit,
  isCovered,
  run,
  targets,
} from '../../scripts/build_theme.mjs';

const COVERED = `<!DOCTYPE html><html><head>\n<link rel="stylesheet" href="${LOADER_LINK}">\n${THEME_START}\n${THEME_END}\n</head><body></body></html>\n`;
/** No Tailwind signature and no markers: the exact class the region writer skips. */
const PLAIN = '<!DOCTYPE html><html><head><style>body { background: #123456; }</style></head><body></body></html>\n';
const FRAGMENT = `<!-- BEGIN: AlgoVault canonical design loader -->\n<link rel="stylesheet" href="${LOADER_LINK}">\n${LOADER_END}\n`;
const MARKED_NO_LOADER = `<!DOCTYPE html><html><head>\n${THEME_START}\n${THEME_END}\n</head><body></body></html>\n`;

const FRAGMENT_EXEMPTION = {
  path: 'landing/_design/loader-snippet.html',
  reason: 'HTML fragment — injected INTO other pages, so a region here would render twice.',
};

const roots: string[] = [];
function mkRoot(files: Record<string, string>, config: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-coverage-test-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'landing', '_design'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ops'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), body);
  if (config !== undefined) fs.writeFileSync(path.join(root, COVERAGE_CONFIG_REL), JSON.stringify(config, null, 2));
  return root;
}

describe('theme coverage — the declared config', () => {
  it('the committed config exempts exactly the loader fragment, with a substantive reason', () => {
    const loaded = loadCoverageConfig(REPO_ROOT);
    expect(loaded.status).toBe('PASS');
    const cfg = loaded.config as { glob: string; exempt: { path: string; reason: string }[] };
    expect(cfg.glob).toBe('landing/**/*.html');
    expect(cfg.exempt.map((e) => e.path)).toEqual(['landing/_design/loader-snippet.html']);
    for (const row of cfg.exempt) expect(row.reason.trim().length).toBeGreaterThan(20);
  });

  it('an absent config is INDETERMINATE, never an empty pass', () => {
    const root = mkRoot({ 'landing/ok.html': COVERED }, undefined);
    expect(loadCoverageConfig(root).status).toBe('INDETERMINATE');
    expect(run({ root, region: '', check: true }).coverageStatus).toBe('INDETERMINATE');
  });

  it('a malformed config is INDETERMINATE', () => {
    const root = mkRoot({ 'landing/ok.html': COVERED }, undefined);
    fs.writeFileSync(path.join(root, COVERAGE_CONFIG_REL), '{ not json');
    expect(loadCoverageConfig(root).status).toBe('INDETERMINATE');
  });

  it.each([
    ['glob absent', { exempt: [] }, 'INDETERMINATE'],
    ['glob not a string', { glob: 7, exempt: [] }, 'INDETERMINATE'],
    ['exempt absent', { glob: 'landing/**/*.html' }, 'INDETERMINATE'],
    ['exempt not an array', { glob: 'landing/**/*.html', exempt: {} }, 'INDETERMINATE'],
    ['exemption with no path', { glob: 'landing/**/*.html', exempt: [{ reason: 'a stated reason here' }] }, 'FAIL'],
    ['exemption with a token reason', { glob: 'landing/**/*.html', exempt: [{ path: 'landing/ok.html', reason: 'wip' }] }, 'FAIL'],
  ])('MUST-REFUSE a config with %s', (_label, config, want) => {
    const root = mkRoot({ 'landing/ok.html': COVERED }, config);
    expect(deriveCoverageTargets(root, config).status).toBe(want);
  });

  it('MUST-CATCH a glob that no longer describes the injector target set', () => {
    const config = { glob: 'landing/*.htm', exempt: [] };
    const root = mkRoot({ 'landing/ok.html': COVERED }, config);
    const derived = deriveCoverageTargets(root, config);
    expect(derived.status).toBe('FAIL');
    expect(derived.why).toMatch(/no longer describes/);
  });

  it('zero targets after exemptions is INDETERMINATE (constructed corpus, so empty is a defect)', () => {
    const config = { glob: 'landing/**/*.html', exempt: [{ path: 'landing/ok.html', reason: 'the only page, exempted' }] };
    const root = mkRoot({ 'landing/ok.html': COVERED }, config);
    expect(deriveCoverageTargets(root, config).status).toBe('INDETERMINATE');
  });
});

describe('theme coverage — uncovered pages', () => {
  it('MUST-CATCH a plain <style>-only page that every pre-R1 leg passed', () => {
    const config = { glob: 'landing/**/*.html', exempt: [FRAGMENT_EXEMPTION] };
    const root = mkRoot(
      { 'landing/ok.html': COVERED, 'landing/plain.html': PLAIN, 'landing/_design/loader-snippet.html': FRAGMENT },
      config,
    );
    const res = run({ root, region: '', check: true });
    expect(res.uncovered).toEqual(['landing/plain.html']);
    expect(res.coverageStatus).toBe('FAIL');
    // The load-bearing half: none of the pre-R1 legs can see it.
    expect(res.missingMarker).not.toContain('landing/plain.html');
    expect(res.missingLoader).not.toContain('landing/plain.html');
    expect(res.drifted).not.toContain('landing/plain.html');
  });

  it('MUST-CATCH a marked page that does not link the design stylesheet', () => {
    const config = { glob: 'landing/**/*.html', exempt: [] };
    const root = mkRoot({ 'landing/bare.html': MARKED_NO_LOADER }, config);
    expect(coverageAudit(root, config).uncovered).toEqual(['landing/bare.html']);
  });

  it('AC1 — deleting the THEME markers from a scratch copy of landing/privacy.html FAILS, naming it', () => {
    const config = { glob: 'landing/**/*.html', exempt: [] };
    const root = mkRoot({}, config);
    const live = fs.readFileSync(path.join(REPO_ROOT, 'landing', 'privacy.html'), 'utf8');
    expect(isCovered(live)).toBe(true); // the control: it is covered before we break it
    const broken = live.replace(THEME_START, '').replace(THEME_END, '');
    fs.writeFileSync(path.join(root, 'landing', 'privacy.html'), broken);
    const audit = coverageAudit(root, config);
    expect(audit.status).toBe('FAIL');
    expect(audit.uncovered).toEqual(['landing/privacy.html']);
  });

  it('MUST-PASS a fully covered tree with the fragment exempt', () => {
    const config = { glob: 'landing/**/*.html', exempt: [FRAGMENT_EXEMPTION] };
    const root = mkRoot({ 'landing/ok.html': COVERED, 'landing/_design/loader-snippet.html': FRAGMENT }, config);
    const audit = coverageAudit(root, config);
    expect([audit.status, audit.uncovered, audit.staleExempt]).toEqual(['PASS', [], []]);
    expect(audit.scanned).toBe(1);
  });
});

describe('theme coverage — stale exemptions', () => {
  it('MUST-CATCH an exemption naming a file that no longer exists', () => {
    const config = {
      glob: 'landing/**/*.html',
      exempt: [{ path: 'landing/deleted-last-wave.html', reason: 'a page that was removed, whose exemption outlived it' }],
    };
    const root = mkRoot({ 'landing/ok.html': COVERED }, config);
    const audit = coverageAudit(root, config);
    expect(audit.status).toBe('FAIL');
    expect(audit.staleExempt.join()).toMatch(/landing\/deleted-last-wave\.html.*does not exist/);
  });

  it('MUST-CATCH an exemption whose file now carries both markers and the loader', () => {
    const config = { glob: 'landing/**/*.html', exempt: [FRAGMENT_EXEMPTION] };
    const root = mkRoot({ 'landing/ok.html': COVERED, 'landing/_design/loader-snippet.html': COVERED }, config);
    const audit = coverageAudit(root, config);
    expect(audit.status).toBe('FAIL');
    expect(audit.staleExempt.join()).toMatch(/already carries both/);
  });
});

describe('theme coverage — the live tree', () => {
  let live: ReturnType<typeof coverageAudit>;
  beforeAll(() => {
    const loaded = loadCoverageConfig(REPO_ROOT);
    expect(loaded.status).toBe('PASS');
    live = coverageAudit(REPO_ROOT, loaded.config);
  });

  it('every public page is covered — uncovered=0, staleExempt=0', () => {
    expect(live.uncovered).toEqual([]);
    expect(live.staleExempt).toEqual([]);
    expect(live.status).toBe('PASS');
  });

  it('the corpus is non-empty and covers the whole injector target set bar the exemption', () => {
    expect(live.scanned).toBeGreaterThan(0);
    expect(live.scanned).toBe(targets(REPO_ROOT).length - 1);
  });

  it('the new page skeleton is itself a covered page', () => {
    const skeleton = fs.readFileSync(path.join(REPO_ROOT, 'landing', '_templates', 'page.template.html'), 'utf8');
    expect(isCovered(skeleton)).toBe(true);
  });
});

afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});
