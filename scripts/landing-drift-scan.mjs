#!/usr/bin/env node
/**
 * LANDING-EYEBROW-LIVEBIND-W1 (B) — READ-ONLY dual-render drift recon.
 *
 * For each W2-DEFERRED twin pair (index `lp-rest`, how-it-works `lp-howit`×3, verify
 * `lp-verify`×2), extract NORMALIZED desktop-vs-mobile visible text (strip script/style/svg/
 * comments/tags/inline-styles/whitespace; neutralize `data-tr-field` / `data-w7-recent-call`
 * LIVE values) and emit a side-by-side + token-multiset diff to
 * `audits/LANDING-DUAL-RENDER-PARITY-DRIFTSCAN-<date>.md`.
 *
 * It is a FORENSIC REPORT, not a gate: the deliberate desktop/mobile abbreviation + legit
 * viewport-only microcopy mean token-equality is not the bar — the report exists so the W2
 * breadth decision (mark ~300 lp-rest fragments?) is evidence-based, not assumed.
 *
 * STRICTLY READ-ONLY of the landing files — writes ONLY the audit report (path from argv[2]
 * or the default below). Zero landing-node mutation.
 *
 *   node scripts/landing-drift-scan.mjs [out.md]
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || path.join(ROOT, 'audits', 'LANDING-DUAL-RENDER-PARITY-DRIFTSCAN-REPORT.md');

const TARGETS = [
  { file: 'landing/index.html', base: 'rest' },
  { file: 'landing/how-it-works.html', base: 'howit' },
  { file: 'landing/verify.html', base: 'verify' },
];

/** Normalize a block to comparable visible copy (live values + structure neutralized). */
function normalize(html) {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');          // SVG diagrams = structure, not copy
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // neutralize LIVE values so they never read as "drift"
  s = s.replace(/(<(\w+)[^>]*\bdata-(?:tr-field|w7-recent-call)="[^"]*"[^>]*>)[\s\S]*?(<\/\2>)/g, '$1⟦live⟧$3');
  s = s.replace(/<[^>]+>/g, ' ');                         // strip tags (drops inline styles/ids)
  s = s.replace(/&[a-z]+;/gi, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Document-ordered blocks for a wrapper class. Starts at the opening `<div` (so the tag strips
 * cleanly, no `class="…"` token leakage) and ends at the FIRST of: the next lp-* dual-render
 * wrapper, a `<footer`, or a `<script` (so the last twin in a file does not over-capture the
 * footer/nav/scripts to EOF — the source of the doubled-token artifact).
 */
function blocks(html, base, variant) {
  const cls = `class="lp-${base}-${variant}"`;
  const boundary = /<div class="lp-[a-z]+-(?:desktop|mobile)"|<footer\b|<script\b/g;
  const out = [];
  let from = 0;
  for (;;) {
    const ci = html.indexOf(cls, from);
    if (ci < 0) break;
    const start = html.lastIndexOf('<', ci);             // back up to the opening "<div"
    boundary.lastIndex = ci + cls.length;
    const m = boundary.exec(html);
    out.push(html.slice(start < 0 ? ci : start, m ? m.index : html.length));
    from = ci + cls.length;
  }
  return out;
}

/** Token-multiset difference (catches added/removed/changed words; order-insensitive). */
function multisetDiff(a, b) {
  const count = (arr) => arr.reduce((acc, w) => ((acc[w] = (acc[w] || 0) + 1), acc), {});
  const ca = count(a.split(' ').filter(Boolean));
  const cb = count(b.split(' ').filter(Boolean));
  const only = (x, y) => Object.entries(x).flatMap(([w, n]) => Array((Math.max(0, n - (y[w] || 0)))).fill(w));
  return { onlyDesktop: only(ca, cb), onlyMobile: only(cb, ca) };
}

let md = `# LANDING-DUAL-RENDER-PARITY — deferred-twin drift scan\n\n`;
md += `Read-only recon (LANDING-EYEBROW-LIVEBIND-W1 B). Normalized visible copy; live \`data-tr-field\`/\`data-w7-recent-call\` values neutralized as ⟦live⟧; SVG/script/style/inline-styles stripped. **Forensic report, not a gate** — the eyebrow abbreviation + legit viewport-only microcopy mean token-equality is not the bar.\n\n`;

let pairCount = 0;
let cleanPairs = 0;
let structuralPairs = 0;
const summary = [];

for (const { file, base } of TARGETS) {
  const raw = await readFile(path.join(ROOT, file), 'utf8');
  // Strip <script>/<style> BEFORE wrapper extraction: a `class="lp-…"` inside a <script>
  // template string is NOT a DOM twin — counting it produced the empty/false-positive pair.
  const html = raw.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const ds = blocks(html, base, 'desktop');
  const ms = blocks(html, base, 'mobile');
  // CSS-selector occurrences (`.lp-base-variant` in <style>) are NOT DOM twins. Count them from
  // the RAW html and report separately so the wrapper count can't be misread as a twin count
  // (the grep-counts-CSS trap that mis-sized this wave's deferred-twin estimate at 6 vs a live 4).
  const cssRefs = (raw.match(new RegExp(`\\.lp-${base}-(?:desktop|mobile)`, 'g')) || []).length;
  const n = Math.max(ds.length, ms.length);
  md += `## ${file} — \`lp-${base}\`: ${ds.length} desktop + ${ms.length} mobile HTML wrapper(s)` +
    (cssRefs ? ` (plus ${cssRefs} \`.lp-${base}-*\` CSS-selector ref(s) in <style> — NOT twins)` : '') + `\n\n`;
  for (let i = 0; i < n; i++) {
    pairCount++;
    const d = ds[i] != null ? normalize(ds[i]) : '⟨missing desktop block⟩';
    const m = ms[i] != null ? normalize(ms[i]) : '⟨missing mobile block⟩';
    const bothEmpty = ds[i] != null && ms[i] != null && d.length === 0 && m.length === 0;
    const identical = d === m;
    const { onlyDesktop, onlyMobile } = (ds[i] != null && ms[i] != null && !bothEmpty) ? multisetDiff(d, m) : { onlyDesktop: [], onlyMobile: [] };
    const verdict = bothEmpty ? 'STRUCTURAL (empty wrapper — grouped/nested, not a content twin)'
      : identical ? 'NO DRIFT (token-identical)'
      : (onlyDesktop.length || onlyMobile.length ? 'REVIEW' : 'NO DRIFT');
    if (bothEmpty) structuralPairs++;
    else if (verdict.startsWith('NO DRIFT')) cleanPairs++;
    summary.push(`${file} lp-${base}[${i}]: ${verdict}`);
    md += `### pair [${i}] — ${verdict}\n\n`;
    md += `- desktop chars: ${d.length} · mobile chars: ${m.length}\n`;
    if (!identical) {
      md += `- only-desktop tokens (${onlyDesktop.length}): ${onlyDesktop.slice(0, 60).join(' ') || '—'}\n`;
      md += `- only-mobile tokens (${onlyMobile.length}): ${onlyMobile.slice(0, 60).join(' ') || '—'}\n`;
    }
    md += `\n<details><summary>normalized desktop</summary>\n\n\`\`\`\n${d.slice(0, 4000)}\n\`\`\`\n</details>\n\n`;
    md += `<details><summary>normalized mobile</summary>\n\n\`\`\`\n${m.slice(0, 4000)}\n\`\`\`\n</details>\n\n`;
  }
}

const reviewPairs = pairCount - cleanPairs - structuralPairs;
md = md.replace('not the bar.\n\n', `not the bar.\n\n## Summary\n\n- ${pairCount} wrapper pair(s); ${cleanPairs} no-drift, ${reviewPairs} REVIEW, ${structuralPairs} structural-empty (not content twins).\n` + summary.map((s) => `  - ${s}`).join('\n') + `\n\n`);

await writeFile(OUT, md);
console.log(`[landing-drift-scan] ${pairCount} wrapper pair(s); ${cleanPairs} no-drift, ${reviewPairs} review, ${structuralPairs} structural-empty → ${path.relative(ROOT, OUT)}`);
