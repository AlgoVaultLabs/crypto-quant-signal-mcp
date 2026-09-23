#!/usr/bin/env node
// DESIGN-SURFACE-TOKENS-W1 CH2 (Q-DST-1) — code wells: `bg-navy-*` → `bg-well` on BLOCKS.
//
// Measured before the wave: a `.code-block` sat at #0a0e1a INSIDE a #0f1526 card — a well,
// darker than its card. Mapping navy-800 to the chip step (0.22) alone would have INVERTED
// that on 81 code blocks and 40 docs example boxes, making them lighter than the card they sit
// in — the opposite of the landing, whose `pre` / `.code-window` wells are the darkest surface
// on the page. Inline `<code>` chips keep bg-navy-800 (0.22) and stay the RAISED step.
//
// Idempotent: a second run reports `replacements=0`.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCodeWellContext, mapClassAttrs, sweepTargets, reportFile } from './lib/class-context.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function sweepText(text) {
  let sample = null;
  const { text: out, count } = mapClassAttrs(text, (value) => {
    if (!isCodeWellContext(value)) return value;
    const next = value
      .split(/(\s+)/)
      .map((t) => (/^bg-navy-\d{3}$/.test(t) ? 'bg-well' : t))
      .join('');
    if (next !== value && !sample) sample = { before: value, after: next };
    return next;
  });
  return { text: out, count, sample };
}

export function run({ root = REPO_ROOT, write = true } = {}) {
  let total = 0;
  for (const file of sweepTargets(root)) {
    const text = fs.readFileSync(file, 'utf8');
    const { text: next, count, sample } = sweepText(text);
    if (!count) continue;
    total += count;
    reportFile(path.relative(root, file), count, sample);
    if (write) fs.writeFileSync(file, next);
  }
  return total;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const total = run({ write: !process.argv.includes('--dry-run') });
  console.log(`sweep-code-wells: replacements=${total}`);
}
