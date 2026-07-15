#!/usr/bin/env node
// OPS-ANALYTICS-TAG-SINGLE-SOURCE-W1 CH2 — build-time analytics injector + drift canary.
//
// Renders the ONE analytics snippet SoT (src/lib/analytics-snippet.ts renderAnalyticsSnippet(),
// compiled to dist/) and injects it between `<!-- ANALYTICS:START -->` / `<!-- ANALYTICS:END -->`
// in the <head> of EVERY landing content page. Idempotent: running twice yields no diff. `--check`
// re-renders and fails (exit 1) on any drifted region OR any content page missing the markers — so
// "the tag fell out of sync" and "a new page never got tracked" become build failures, structurally.
//
//   node scripts/build_analytics.mjs           # write: inject into every content page
//   node scripts/build_analytics.mjs --check    # CI: 0 = in sync + total coverage, 1 = drift/missing
//
// MIRRORS scripts/build_nav.mjs (2nd injector instance — see OPS-SHARED-INJECT-HELPER-EXTRACTION-
// W{NEXT}; do NOT extract the shared helper now, it would touch frozen build_nav). Per architect
// Q3(a): the WRITE is a manual/edit-time step; the COMMITTED output + `--check` (deploy.yml +
// prepublishOnly + weekly cron) are the guardrail — build_analytics is NOT in the build:landing chain.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

export const ANALYTICS_START = '<!-- ANALYTICS:START -->';
export const ANALYTICS_END = '<!-- ANALYTICS:END -->';

// Per architect Q1(c): track EVERY public content page → the --check is TOTAL. The only landing
// *.html that must NOT carry the region are genuine non-content stubs — the build/design partials
// + generator templates under `_`-prefixed dirs (landing/_design/, landing/_templates/). Anything
// else (24 previously-tagged + 4 hub + 16 answer + privacy + terms) MUST be marked.
export const EXCLUDE_DIR_PREFIX = '_';
export function isExcluded(relFromLanding) {
  return relFromLanding.split(path.sep).some((seg) => seg.startsWith(EXCLUDE_DIR_PREFIX));
}

/** The canonical analytics region string (identical for every surface). Lazy so importers can stub. */
export function renderAnalyticsRegion() {
  const { renderAnalyticsSnippet } = require(path.join(REPO_ROOT, 'dist', 'lib', 'analytics-snippet.js'));
  return renderAnalyticsSnippet();
}

/**
 * Replace the content between the first ANALYTICS:START and ANALYTICS:END (markers preserved)
 * with the canonical region. Pure + idempotent.
 * @returns {{ marked: boolean, html: string }} marked=false when the file has no markers.
 */
export function applyRegion(html, region) {
  const s = html.indexOf(ANALYTICS_START);
  const e = html.indexOf(ANALYTICS_END);
  if (s === -1 || e === -1 || e < s) return { marked: false, html };
  const before = html.slice(0, s);
  const after = html.slice(e + ANALYTICS_END.length);
  return { marked: true, html: `${before}${ANALYTICS_START}\n${region}\n${ANALYTICS_END}${after}` };
}

/** Recursively list every *.html under a dir. */
export function listHtml(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listHtml(p));
    else if (ent.isFile() && ent.name.endsWith('.html')) out.push(p);
  }
  return out;
}

/**
 * Inject (or --check) the analytics region across every content landing page.
 * @returns {{ changed: string[], drifted: string[], missingMarker: string[] }}
 *   changed        = files written (write mode) / would-change (== drifted in check mode)
 *   drifted        = marked files whose region != freshly rendered
 *   missingMarker  = NON-excluded content pages that lack the ANALYTICS markers (untracked)
 */
export function run({ check = false, root = REPO_ROOT } = {}) {
  const region = renderAnalyticsRegion();
  const landing = path.join(root, 'landing');
  const files = listHtml(landing);
  const changed = [];
  const drifted = [];
  const missingMarker = [];
  for (const file of files) {
    const rel = path.relative(root, file);
    const relFromLanding = path.relative(landing, file);
    if (isExcluded(relFromLanding)) continue; // non-content stub (partials/templates)
    const html = fs.readFileSync(file, 'utf8');
    const { marked, html: next } = applyRegion(html, region);
    if (!marked) {
      // A content page with no ANALYTICS markers = an untracked / missed page (TOTAL-coverage law).
      missingMarker.push(rel);
      continue;
    }
    if (next !== html) {
      drifted.push(rel);
      if (!check) {
        fs.writeFileSync(file, next);
        changed.push(rel);
      }
    }
  }
  return { changed, drifted, missingMarker };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const check = process.argv.includes('--check');
  const { changed, drifted, missingMarker } = run({ check });
  if (check) {
    const problems = [...drifted, ...missingMarker];
    if (problems.length > 0) {
      if (drifted.length) console.error(`✗ build_analytics --check: ${drifted.length} analytics region(s) OUT OF SYNC:\n  ${drifted.join('\n  ')}`);
      if (missingMarker.length)
        console.error(`✗ build_analytics --check: ${missingMarker.length} content page(s) MISSING <!-- ANALYTICS:START/END --> markers (untracked):\n  ${missingMarker.join('\n  ')}`);
      console.error(`  Run: node scripts/build_analytics.mjs  (regenerates every marked analytics region)`);
      process.exit(1);
    }
    console.log('✓ build_analytics --check: every content page carries the in-sync analytics region.');
  } else {
    console.log(`✓ build_analytics: injected ${changed.length} analytics region(s)${changed.length ? ':\n  ' + changed.join('\n  ') : ' (all already in sync)'}`);
    if (missingMarker.length) console.warn(`  note: ${missingMarker.length} content page(s) still lack markers: ${missingMarker.join(', ')}`);
  }
}
