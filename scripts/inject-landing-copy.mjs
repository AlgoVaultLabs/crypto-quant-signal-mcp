#!/usr/bin/env node
/**
 * LANDING-DUAL-RENDER-PARITY-W1 — build-time landing-copy injector.
 *
 * Rewrites every `data-av-copy="<key>.<variant>"` node's inner content across `landing/*.html`
 * to match the single source (src/lib/landing-content.ts → compiled dist/lib/landing-content.js).
 * Modelled on `scripts/inject-footer.mjs`. Idempotent; `--check` = the CI / pre-push drift canary.
 *
 *   node scripts/inject-landing-copy.mjs           # rewrite the marked nodes in place
 *   node scripts/inject-landing-copy.mjs --check    # exit 1 if any marked node is out of sync
 *
 * Requires `npm run build` first (loads the tsc-emitted CJS SoT via createRequire — the
 * build_landing.mjs / inject-footer.mjs pattern). Run at WAVE time + commit the result; the
 * deploy then cp's the already-unified files.
 *
 * Marked copy nodes are LEAVES (a plain-text span/p/a, no nested same-tag) — so a non-greedy
 * inner match keyed on the full `data-av-copy` marker is safe. The marker is NEVER placed on
 * a data-tr-field / live-bound node (firewall in src/lib/landing-content.ts), so this script
 * structurally cannot touch live track-record data.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const DIST = path.join(REPO_ROOT, 'dist', 'lib', 'landing-content.js');
if (!existsSync(DIST)) {
  console.error(`[inject-landing-copy] missing ${DIST} — run \`npm run build\` first.`);
  process.exit(2);
}
const { LANDING_COPY, LANDING_COPY_MARKER } = require(DIST);

const checkMode = process.argv.includes('--check');
const LANDING_DIR = path.join(REPO_ROOT, 'landing');

// <tag … data-av-copy="KEY.VARIANT" …>INNER</tag>. Inner is non-greedy up to the matching
// close tag (backref \2); copy nodes never nest the same tag, so this is exact.
const MARKER_RE = new RegExp(
  `(<(\\w+)\\b[^>]*\\b${LANDING_COPY_MARKER}="([^"]+)"[^>]*>)([\\s\\S]*?)(</\\2>)`,
  'g',
);

async function landingHtmlFiles() {
  const out = [];
  async function walk(absDir, relDir) {
    for (const e of await readdir(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, e.name);
      const rel = path.posix.join(relDir, e.name);
      if (e.isDirectory()) await walk(abs, rel);
      else if (e.name.endsWith('.html')) out.push(rel);
    }
  }
  await walk(LANDING_DIR, 'landing');
  return out.sort();
}

const files = await landingHtmlFiles();
let totalChanged = 0;
const unknownMarkers = [];

for (const rel of files) {
  const abs = path.join(REPO_ROOT, rel);
  const before = await readFile(abs, 'utf8');
  if (!before.includes(`${LANDING_COPY_MARKER}=`)) continue; // no markers → skip
  const changed = [];
  const after = before.replace(MARKER_RE, (m, open, _tag, marker, inner, close) => {
    const dot = marker.lastIndexOf('.');
    const key = marker.slice(0, dot);
    const variant = marker.slice(dot + 1);
    const entry = LANDING_COPY[key];
    if (!entry || (variant !== 'desktop' && variant !== 'mobile')) {
      unknownMarkers.push(`${rel}: ${marker}`);
      return m;
    }
    const want = entry[variant];
    if (inner === want) return m;
    changed.push(marker);
    return `${open}${want}${close}`;
  });
  if (after !== before) {
    if (checkMode) {
      console.error(`[inject-landing-copy] DRIFT: ${rel} — ${changed.length} node(s) differ from the SoT: ${changed.join(', ')}`);
    } else {
      await writeFile(abs, after);
      console.log(`[inject-landing-copy] ${rel}: ${changed.length} node(s) re-synced from the SoT (${changed.join(', ')}).`);
    }
    totalChanged += changed.length;
  }
}

if (unknownMarkers.length) {
  console.error(`[inject-landing-copy] ${unknownMarkers.length} marker(s) reference an unknown key/variant: ${unknownMarkers.join(', ')}`);
  process.exit(checkMode ? 1 : 3);
}

if (checkMode) {
  if (totalChanged > 0) {
    console.error(`[inject-landing-copy] --check FAILED: ${totalChanged} node(s) out of sync with the SoT (run \`node scripts/inject-landing-copy.mjs\`).`);
    process.exit(1);
  }
  console.log('[inject-landing-copy] --check OK — all data-av-copy nodes match the SoT.');
} else {
  console.log(`[inject-landing-copy] done — ${totalChanged} node(s) re-synced across ${files.length} landing file(s).`);
}
