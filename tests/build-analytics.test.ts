// OPS-ANALYTICS-TAG-SINGLE-SOURCE-W1 CH2 — injector + drift-canary contract.
//
// Authored as a vitest .ts (NOT the spec's .mjs) ON PURPOSE: the pre-push baseline gate runs
// `node --test` over every tests/**/*.test.mjs, so a vitest-authored .mjs double-runs under
// node:test and false-fails (build-nav.test.ts / build-docs.test.ts precedent). `.ts` is
// vitest-only. Requires `npm run build` first (renderAnalyticsRegion imports the compiled dist SoT).
//
// READ-ONLY on the real landing/: every write/drift test operates on a scratch mkdtemp repo, never
// the committed tree (a parallel worker reading landing/*.html would race a mid-suite write).
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  applyRegion, renderAnalyticsRegion, run, isExcluded,
  REPO_ROOT, ANALYTICS_START, ANALYTICS_END,
} from '../scripts/build_analytics.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const region = () => renderAnalyticsRegion();
const marked = (inner) => `<html><head>${ANALYTICS_START}\n${inner}\n${ANALYTICS_END}</head><body>x</body></html>`;

beforeAll(() => {
  // renderAnalyticsRegion requires dist/lib/analytics-snippet.js — CI/pre-push run `npm run build`
  // before the suite; only compile if MISSING (a full tsc here can exceed vitest's hookTimeout).
  if (!existsSync(join(REPO, 'dist', 'lib', 'analytics-snippet.js'))) {
    execFileSync('npx', ['tsc'], { cwd: REPO, stdio: 'ignore' });
  }
}, 120_000);

describe('CH2 — applyRegion is a pure, idempotent marker replace', () => {
  it('replaces the marked region with the canonical snippet', () => {
    const r = applyRegion(marked('<!-- OLD TAG -->'), '<!-- NEW -->');
    expect(r.marked).toBe(true);
    expect(r.html).toContain('<!-- NEW -->');
    expect(r.html).not.toContain('OLD TAG');
    expect(r.html).toContain(ANALYTICS_START);
    expect(r.html).toContain(ANALYTICS_END);
  });
  it('is idempotent — applying twice yields byte-identical output', () => {
    const once = applyRegion(marked('stale'), region()).html;
    const twice = applyRegion(once, region()).html;
    expect(twice).toBe(once);
  });
  it('returns marked=false (no-op) when the file has no markers', () => {
    const r = applyRegion('<html><head>no markers</head></html>', region());
    expect(r.marked).toBe(false);
    expect(r.html).toBe('<html><head>no markers</head></html>');
  });
  it('the injected region carries the live first-party tag (single-derivation from the SoT)', () => {
    const r = applyRegion(marked('x'), region());
    expect(r.html).toContain('<script async src="/js/insights.js"></script>');
    expect(r.html).toContain('plausible.init({endpoint:"/pa/event"})');
  });
});

describe('CH2 — isExcluded: only _-prefixed non-content dirs are skipped', () => {
  it('excludes _design + _templates, includes real content pages', () => {
    expect(isExcluded('_design/loader-snippet.html')).toBe(true);
    expect(isExcluded('_templates/answer-page.template.html')).toBe(true);
    expect(isExcluded('index.html')).toBe(false);
    expect(isExcluded('integrations/binance.html')).toBe(false);
    expect(isExcluded('mcp.html')).toBe(false);
  });
});

describe('CH2 — build_analytics --check bites on drift + missing marker, idempotent on write', () => {
  function scratch(files) {
    const root = mkdtempSync(join(tmpdir(), 'analytics-'));
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return root;
  }

  it('--check reports a marked page whose region was hand-edited as drifted', () => {
    const root = scratch({ 'landing/page.html': marked('<!-- stale hand-edited tag -->') });
    expect(run({ check: true, root }).drifted).toEqual(['landing/page.html']);
  });
  it('write syncs the region, then a second --check is a no-op (idempotent)', () => {
    const root = scratch({ 'landing/page.html': marked('stale') });
    expect(run({ check: false, root }).changed).toEqual(['landing/page.html']);
    const recheck = run({ check: true, root });
    expect(recheck.drifted).toEqual([]);
    expect(readFileSync(join(root, 'landing', 'page.html'), 'utf8')).toContain('insights.js');
  });
  it('--check flags a content page that LACKS the markers (untracked → TOTAL-coverage law)', () => {
    const root = scratch({ 'landing/orphan.html': '<html><head>no markers</head><body>content</body></html>' });
    expect(run({ check: true, root }).missingMarker).toEqual(['landing/orphan.html']);
  });
  it('a _-prefixed non-content stub without markers is NOT flagged missing', () => {
    const root = scratch({
      'landing/_design/loader-snippet.html': '<div>partial</div>',
      'landing/_templates/answer-page.template.html': '<html><head></head></html>',
      'landing/real.html': marked('x'),
    });
    const { missingMarker } = run({ check: true, root });
    expect(missingMarker).toEqual([]); // the 2 _-stubs skipped; real.html is marked
  });
});
