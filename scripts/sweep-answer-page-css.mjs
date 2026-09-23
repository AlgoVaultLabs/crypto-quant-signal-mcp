#!/usr/bin/env node
// DESIGN-SURFACE-TOKENS-W1 CH2 (Q-DST-6) — the answer-page family's INLINE CSS.
//
// The 16 answer pages + their template use ZERO Tailwind colour utilities: their navy comes
// from a hand-authored <style> block and one sticky <nav> style attribute. The theme region
// therefore changes nothing visible on them, and without this sweep the wave would have
// retired the slab everywhere EXCEPT the pages a reader reaches from search.
//
// Every mapping is a token substitution, never a colour edit: #0a0e1a on a `pre` is the WELL
// step, the same `pre` recipe the landing uses; #0f1526 on an inline `code` is the chip step;
// `.card` is the surface; #1c2536 / #141c2e are both the hairline.
//
// Per-file counts must be IDENTICAL across the 16 pages (they are one template's output) — an
// outlier means a page drifted from the family and is printed rather than silently swept.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** ordered: the more specific rule first, so a later generic mapping cannot pre-empt it. */
export const MAPPINGS = [
  ['pre { background: #0a0e1a; border: 1px solid #1c2536;', 'pre { background: var(--well); border: 1px solid var(--line);'],
  ['p code, li code, td code { background: #0f1526;', 'p code, li code, td code { background: var(--bg-3);'],
  ['.card { background: #0a0e1a; border: 1px solid #1c2536;', '.card { background: var(--surface); border: 1px solid var(--line);'],
  ['.verdict div { background: #0a0e1a;', '.verdict div { background: var(--surface);'],
  ['border-bottom: 1px solid #1c2536;', 'border-bottom: 1px solid var(--line);'],
  ['border: 1px solid #1c2536;', 'border: 1px solid var(--line);'],
  ['border-bottom:1px solid #141c2e', 'border-bottom:1px solid var(--line)'],
  ['background:rgba(6,10,20,0.85)', 'background:oklch(var(--bg-lch, 0.16 0.012 265) / 0.85)'],
  ['body { background: #060a14;', 'body { background: var(--bg);'],
];

export function answerPageTargets(root = REPO_ROOT) {
  const files = [path.join(root, 'landing', '_templates', 'answer-page.template.html')];
  for (const f of fs.readdirSync(path.join(root, 'landing'))) {
    if (!f.endsWith('.html')) continue;
    const p = path.join(root, 'landing', f);
    const html = fs.readFileSync(p, 'utf8');
    // The family signature: the hand-authored answer-page shell, never a generated page.
    if (html.includes('<nav style="position:sticky;top:0;z-index:20;')) files.push(p);
  }
  return files.filter((f) => fs.existsSync(f)).sort();
}

export function sweepText(text) {
  let count = 0;
  let sample = null;
  for (const [from, to] of MAPPINGS) {
    while (text.includes(from)) {
      if (!sample) sample = { before: from, after: to };
      text = text.replace(from, to);
      count += 1;
    }
  }
  return { text, count, sample };
}

export function run({ root = REPO_ROOT, write = true } = {}) {
  let total = 0;
  const perFile = [];
  for (const file of answerPageTargets(root)) {
    const text = fs.readFileSync(file, 'utf8');
    const { text: next, count, sample } = sweepText(text);
    const rel = path.relative(root, file);
    if (count) {
      total += count;
      console.log(`  ${rel}: ${count} replacement(s)`);
      if (sample) {
        console.log(`      before: ${sample.before.slice(0, 140)}`);
        console.log(`      after:  ${sample.after.slice(0, 140)}`);
      }
      if (write) fs.writeFileSync(file, next);
    }
    perFile.push({ rel, count });
  }
  // Q-DST-6 expected identical per-file counts. MEASURED FALSE, and the cause is benign: the
  // family is not byte-uniform — 10 pages carry no `th, td` rule and only 3 comparison pages
  // carry `.verdict div` (which contributes 2 mappings). So the honest invariant is not "same
  // count everywhere", it is "NO legacy literal survives anywhere", which is what the canary
  // gates. The distribution is printed so a genuinely NEW shape still shows up.
  const dist = {};
  for (const p of perFile) dist[p.count] = (dist[p.count] || 0) + 1;
  console.log(`  per-file count distribution (count: files): ${Object.entries(dist).map(([c, n]) => `${c}: ${n}`).join(', ')}`);
  const residual = [];
  for (const file of answerPageTargets(root)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const lit of ['#060a14', '#0a0e1a', '#0f1526', '#1c2536', '#141c2e', 'rgba(6,10,20']) {
      if (text.includes(lit)) residual.push(`${path.relative(root, file)}: ${lit}`);
    }
  }
  if (residual.length) {
    console.error(`  ✗ legacy literals survive in ${residual.length} place(s):\n  ${residual.join('\n  ')}`);
    if (write) process.exitCode = 1;
  }
  return total;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const total = run({ write: !process.argv.includes('--dry-run') });
  console.log(`sweep-answer-page-css: replacements=${total}`);
}
