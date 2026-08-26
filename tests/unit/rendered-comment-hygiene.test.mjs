// BINANCE-AGENT-OS-GEO-AND-SUBMISSIONS-W2 CH1 R4 — the WIRING for
// scripts/check-rendered-comment-hygiene.mjs.
//
// `check-canaries-wired.mjs` counts a gate as WIRED when something that is not a comment
// actually invokes it. This file does, and it runs under `node --test` in the pre-push gate and
// in deploy.yml's canary step — so the gate cannot become the committed-never-run shape its own
// class exists to prevent.
//
// It deliberately drives the REAL `auditCommentHygiene()` against the REAL tree, because the
// script's `--self-test` builds an in-memory corpus and is therefore structurally blind to the
// disk-reading path it replaces. That seam is exactly where a gate goes dark.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditCommentHygiene,
  loadConfig,
  htmlFiles,
  isBlocking,
  isAllowed,
  normalise,
  selfTest,
} from '../../scripts/check-rendered-comment-hygiene.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the gate\'s own two-way self-test passes', () => {
  assert.equal(selfTest(), true);
});

test('the REAL audit over the REAL tree returns CLEAN on the blocking surface', () => {
  const out = auditCommentHygiene();
  assert.equal(out.verdict, 'CLEAN', `blocking leaks:\n${out.reasons.join('\n')}`);
  assert.equal(out.blocking.length, 0);
});

test('the real scan is non-vacuous — files AND comments were actually read', () => {
  const out = auditCommentHygiene();
  assert.ok(out.files > 0, 'zero HTML files scanned');
  assert.ok(out.comments > 0, 'zero comments extracted');
});

test('the blocking surface is discovered by the real glob', () => {
  const cfg = loadConfig();
  const blocking = htmlFiles().filter((f) => isBlocking(f, cfg));
  assert.ok(blocking.length >= 25, `expected >=25 integration pages, found ${blocking.length}`);
  assert.ok(blocking.every((f) => f.startsWith('landing/integrations/')));
});

test('isBlocking does not swallow nested paths under the blocking dir', () => {
  const cfg = loadConfig();
  assert.equal(isBlocking('landing/integrations/binance.html', cfg), true);
  assert.equal(isBlocking('landing/integrations/nested/deep.html', cfg), false);
  assert.equal(isBlocking('landing/faq.html', cfg), false);
});

test('every allow-list row carries a reason, and the promotion criterion is counted AND dated', () => {
  const cfg = loadConfig();
  assert.ok(cfg.matchers.length > 0);
  for (const m of cfg.matchers) assert.ok(m.reason && m.reason.length > 20, `thin reason for ${m.pattern}`);
  assert.equal(typeof cfg.promotion.max_leaks, 'number');
  assert.match(cfg.promotion.decide_by, /^\d{4}-\d{2}-\d{2}$/);
});

test('marker matching is exact — a prose comment that merely mentions a marker still leaks', () => {
  const cfg = loadConfig();
  assert.equal(isAllowed('NAV:START', cfg), true);
  assert.equal(isAllowed(' NAV:START ', cfg), true, 'whitespace must be normalised');
  assert.equal(isAllowed('NAV:START is injected by build_nav, see wave W1', cfg), false);
  assert.equal(isAllowed('DESIGN-W10-FF-2 (2026-05-12): tier-stat-card wrapping', cfg), false);
});

test('multi-line comments are extracted whole, not per line', () => {
  assert.equal(normalise('\n  a\n  b\n'), 'a b');
});

// ── the regression this chapter retired ─────────────────────────────────────────────────────

test('no rendered integration page ships an internal directive quote or a wave ID', () => {
  const cfg = loadConfig();
  const pages = htmlFiles().filter((f) => isBlocking(f, cfg));
  const offenders = [];
  for (const rel of pages) {
    const html = readFileSync(join(ROOT, rel), 'utf8');
    for (const m of html.matchAll(/<!--([\s\S]*?)-->/g)) {
      const t = normalise(m[1]);
      if (/Mr\.1/.test(t) || /-W\d/.test(t)) offenders.push(`${rel}: ${t.slice(0, 80)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the design-loader marker survives the de-parenthesising byte-identical', () => {
  const cfg = loadConfig();
  const pages = htmlFiles().filter((f) => isBlocking(f, cfg));
  assert.ok(pages.length > 0);
  for (const rel of pages) {
    const html = readFileSync(join(ROOT, rel), 'utf8');
    // The marker is the contract; only its wave-ID parenthetical was removed.
    assert.ok(html.includes('<!-- BEGIN: AlgoVault canonical design loader -->'), `${rel} lost the BEGIN marker`);
    assert.ok(html.includes('<!-- END: AlgoVault canonical design loader -->'), `${rel} lost the END marker`);
  }
});

test('every rendered page carries an explicit, non-default publication date', () => {
  const cfg = loadConfig();
  const pages = htmlFiles().filter((f) => isBlocking(f, cfg));
  const today = new Date().toISOString().slice(0, 10);
  for (const rel of pages) {
    const html = readFileSync(join(ROOT, rel), 'utf8');
    const pub = html.match(/"datePublished": "(\d{4}-\d{2}-\d{2})/);
    const mod = html.match(/"dateModified": "(\d{4}-\d{2}-\d{2})/);
    assert.ok(pub && mod, `${rel} is missing a JSON-LD date`);
    assert.ok(pub[1] <= mod[1], `${rel}: datePublished ${pub[1]} > dateModified ${mod[1]}`);
    assert.ok(mod[1] <= today, `${rel}: dateModified ${mod[1]} is in the future`);
  }
});

test('the 25 pages do NOT all share one publication date — the defect this chapter fixed', () => {
  const cfg = loadConfig();
  const dates = new Set();
  for (const rel of htmlFiles().filter((f) => isBlocking(f, cfg))) {
    const m = readFileSync(join(ROOT, rel), 'utf8').match(/"datePublished": "(\d{4}-\d{2}-\d{2})/);
    if (m) dates.add(m[1]);
  }
  assert.ok(dates.size >= 6, `expected >=6 distinct publication dates across the corpus, got ${dates.size}: ${[...dates].sort()}`);
});
