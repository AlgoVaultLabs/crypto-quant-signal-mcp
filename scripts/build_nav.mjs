#!/usr/bin/env node
// NAV-PLATFORM-GENERATOR-W1 CH2 — build-time nav injector + drift canary.
//
// Renders the ONE canonical nav region (src/lib/site-nav.ts renderSiteNav(), compiled to
// dist/) and injects it between `<!-- NAV:START -->` / `<!-- NAV:END -->` in every marked
// landing/**/*.html page — desktop bar AND mobile drawer from the SAME model. Idempotent:
// running twice yields no diff. `--check` re-renders and fails (exit 1) on any drifted or
// marker-missing nav page — so "the mobile menu fell out of sync" and "we forgot page N"
// become build failures, structurally.
//
//   node scripts/build_nav.mjs           # write: inject into every marked page
//   node scripts/build_nav.mjs --check   # CI: 0 = in sync, 1 = drift/missing-marker (lists offenders)
//
// Mirrors scripts/build_landing.mjs (createRequire → compiled dist, --check guard).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

export const NAV_START = '<!-- NAV:START -->';
export const NAV_END = '<!-- NAV:END -->';
// The desktop nav-links signature — any landing page carrying THIS must be a marked, injected
// nav page (shared with scripts/check_mobile_nav_parity.sh).
export const DESKTOP_SIG = 'hidden sm:flex items-center gap-6';

/** The canonical nav region string (identical for every surface). Lazy so importers can stub. */
export function renderNavRegion() {
  const { renderSiteNav } = require(path.join(REPO_ROOT, 'dist', 'lib', 'site-nav.js'));
  return renderSiteNav();
}

/**
 * Replace the content between the first NAV:START and NAV:END (inclusive of the markers'
 * inner content, markers preserved) with the canonical region. Pure + idempotent.
 * @returns {{ marked: boolean, html: string }} marked=false when the file has no markers.
 */
export function applyRegion(html, region) {
  const s = html.indexOf(NAV_START);
  const e = html.indexOf(NAV_END);
  if (s === -1 || e === -1 || e < s) return { marked: false, html };
  const before = html.slice(0, s);
  const after = html.slice(e + NAV_END.length);
  return { marked: true, html: `${before}${NAV_START}\n${region}\n${NAV_END}${after}` };
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
 * Inject (or --check) the nav region across every landing page.
 * @returns {{ changed: string[], drifted: string[], missingMarker: string[] }}
 *   changed        = files written (write mode) / would-change (check mode == drifted)
 *   drifted        = marked files whose region != freshly rendered
 *   missingMarker  = nav-bearing pages (desktop signature) that lack the NAV markers
 */
export function run({ check = false, root = REPO_ROOT } = {}) {
  const region = renderNavRegion();
  const landing = path.join(root, 'landing');
  const files = listHtml(landing);
  const changed = [];
  const drifted = [];
  const missingMarker = [];
  for (const file of files) {
    const rel = path.relative(root, file);
    const html = fs.readFileSync(file, 'utf8');
    const { marked, html: next } = applyRegion(html, region);
    if (!marked) {
      // A page carrying the desktop nav signature but no markers = an un-migrated / missed nav page.
      if (html.includes(DESKTOP_SIG)) missingMarker.push(rel);
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
      if (drifted.length) console.error(`✗ build_nav --check: ${drifted.length} nav region(s) OUT OF SYNC:\n  ${drifted.join('\n  ')}`);
      if (missingMarker.length)
        console.error(`✗ build_nav --check: ${missingMarker.length} nav-bearing page(s) MISSING <!-- NAV:START/END --> markers:\n  ${missingMarker.join('\n  ')}`);
      console.error(`  Run: node scripts/build_nav.mjs  (regenerates every marked nav region)`);
      process.exit(1);
    }
    console.log('✓ build_nav --check: every nav region in sync.');
  } else {
    console.log(`✓ build_nav: injected ${changed.length} nav region(s)${changed.length ? ':\n  ' + changed.join('\n  ') : ' (all already in sync)'}`);
    if (missingMarker.length) console.warn(`  note: ${missingMarker.length} nav-bearing page(s) still lack markers: ${missingMarker.join(', ')}`);
  }
}
