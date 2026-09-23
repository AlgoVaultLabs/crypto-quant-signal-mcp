#!/usr/bin/env node
// DESIGN-SURFACE-TOKENS-W1 CH2 — card hairline sweep: `border-white/5` → `border-line`.
//
// ONLY inside a class value that is a CARD context (bg-navy-700 / bg-navy-800 / bg-well /
// card-hover). The nav and footer hairlines are NOT cards and keep `border-white/5` — the
// shared predicate in scripts/lib/class-context.mjs is what makes the sweep and the canary
// agree on that boundary.
//
// Idempotent: a second run reports `replacements=0`, which is what the chapter gate asserts.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCardContext, mapClassAttrs, replaceToken, sweepTargets, reportFile } from './lib/class-context.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function sweepText(text) {
  let sample = null;
  const { text: out, count } = mapClassAttrs(text, (value) => {
    if (!isCardContext(value) || !value.includes('border-white/5')) return value;
    const next = replaceToken(value, 'border-white/5', 'border-line');
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
  console.log(`sweep-card-border: replacements=${total}`);
}
