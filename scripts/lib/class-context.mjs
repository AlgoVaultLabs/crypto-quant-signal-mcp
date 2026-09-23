// DESIGN-SURFACE-TOKENS-W1 CH2 — the ONE class-context predicate.
//
// Shared by scripts/sweep-card-border.mjs, scripts/sweep-code-wells.mjs and
// scripts/check-legacy-navy-literals.mjs. A second implementation of "is this border a CARD
// border or a nav hairline?" would drift, and the bug would live in whichever copy nobody is
// watching — the sweep and the canary that guards the sweep must answer it identically.
//
// WHY WHOLE-VALUE, NEVER A LOOKAHEAD: the spec's first form was
// `border-white/5(?=[^"]*(bg-navy-[78]00|card-hover))`, which matched 0 of 368 real sites,
// because in every authored class string the context token comes BEFORE the border token
// (`card-hover bg-navy-700 border border-white/5 rounded-xl`). A lookahead cannot see behind
// itself, and a spec-shaped MUST-CATCH fixture would have hidden that.
import * as fs from 'node:fs';
import * as path from 'node:path';

/** `class="…"` (also `class='…'`), the only form authored in this repo's HTML and TS templates. */
export const CLASS_ATTR_RE = /class=("([^"]*)"|'([^']*)')/g;

/** A card-ish surface: a card face, a chip/well, or the shared hover recipe. */
export function isCardContext(classValue) {
  return ['bg-navy-700', 'bg-navy-800', 'bg-well', 'card-hover'].some((t) => classValue.includes(t));
}

/** A code WELL (block), as opposed to an inline `<code>` chip. */
export function isCodeWellContext(classValue) {
  const tokens = classValue.split(/\s+/);
  if (tokens.includes('code-block')) return true;
  // The docs "example prompt" box: the only other block-level navy-800 surface.
  return ['bg-navy-800', 'rounded-lg', 'px-4', 'py-2.5', 'italic'].every((t) => tokens.includes(t));
}

/**
 * Rewrite every `class="…"` value through `fn(value) -> value`. Returns { text, count } where
 * count is the number of ATTRIBUTES changed.
 */
export function mapClassAttrs(text, fn) {
  let count = 0;
  const out = text.replace(CLASS_ATTR_RE, (whole, _q, dq, sq) => {
    const quote = dq !== undefined ? '"' : "'";
    const value = dq !== undefined ? dq : sq;
    const next = fn(value);
    if (next === value) return whole;
    count += 1;
    return `class=${quote}${next}${quote}`;
  });
  return { text: out, count };
}

/** Token-wise replace inside a class value (never a substring of a longer token). */
export function replaceToken(classValue, from, to) {
  return classValue
    .split(/(\s+)/)
    .map((t) => (t === from ? to : t))
    .join('');
}

/** Files a class sweep or the canary looks at: authored HTML + the TS template producers. */
export function sweepTargets(root) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (['node_modules', '_design', '__snapshots__'].includes(ent.name)) continue;
        walk(p);
      } else if (/\.(html|ts)$/.test(ent.name)) out.push(p);
    }
  };
  walk(path.join(root, 'landing'));
  walk(path.join(root, 'docs-src'));
  walk(path.join(root, 'src'));
  return out.sort();
}

/** One-line per-file report: count + the FIRST before/after pair (Design.md §12). */
export function reportFile(rel, count, sample) {
  console.log(`  ${rel}: ${count} replacement(s)`);
  if (sample) {
    console.log(`      before: ${sample.before.slice(0, 150)}`);
    console.log(`      after:  ${sample.after.slice(0, 150)}`);
  }
}
