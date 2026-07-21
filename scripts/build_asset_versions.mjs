#!/usr/bin/env node
// OPS-LANDING-ASSET-CACHE-BUST-W1 — content-hash stamper for first-party landing JS.
//
//   node scripts/build_asset_versions.mjs           # write: stamp ?v=<hash> on every ref
//   node scripts/build_asset_versions.mjs --check    # CI: 0 = every ref matches its file, 1 = drift
//
// ## Why
//
// Origin (Caddy, :186) serves landing assets `public, max-age=60, must-revalidate`.
// CLOUDFLARE REWRITES THAT TO max-age=14400 (4h) for responses it caches — a zone-level
// Browser Cache TTL. Measured 2026-07-21:
//
//   origin  : cache-control: public, max-age=60,    must-revalidate
//   via CF  : cache-control: public, max-age=14400, must-revalidate   cf-cache-status: REVALIDATED
//
// So a correct deploy stayed INVISIBLE to returning visitors for up to 4h: OPS-MERKLE-BATCH-
// IDENTITY-W1 shipped a fixed track-record-proxy.js, and /verify still showed merkle batch
// "#100" against an on-chain "#102" — because the browser kept executing its cached copy, and
// the proxy's refresh interval ACTIVELY re-wrote the hydrated span back to the stale value.
// Post-deploy visual verification was therefore unreliable: origin, CDN and API could all be
// verified correct while the rendered page stayed wrong.
//
// ## Why THIS fix and not the other two
//
//   1. "Lower max-age in the Caddyfile" — ALREADY DONE (60s, from the 2026-04-19 verify
//      incident) and overridden by Cloudflare. Editing it changes nothing.
//   2. "Cloudflare cache-rule / purge-on-deploy" — a purge clears the EDGE, but the stale copy
//      is in the USER'S BROWSER (the edge was already REVALIDATED with fresh bytes). It cannot
//      fix this. Only a Browser-Cache-TTL change would, and that needs zone-settings access the
//      deploy token does not have (verified: 10000 Authentication error on /settings and
//      /rulesets; the token is DNS-scoped).
//   3. Content-versioned URLs — THIS. Works regardless of any downstream TTL, needs no
//      Cloudflare permission, and makes the long asset TTL a FEATURE (immutable per-version).
//
// HTML is safe to rely on for propagation: it is `cf-cache-status: DYNAMIC` (Cloudflare does not
// cache it) so the origin's 60s browser TTL passes through untouched. A returning visitor picks
// up new HTML within ~60s, that HTML carries the new `?v=`, and the new URL cannot hit the old
// cache entry. Verified 2026-07-21.
//
// ## Scope rule (self-maintaining)
//
// Only refs whose file EXISTS under landing/js/ are stamped. That is why `/js/insights.js` is
// left alone by construction: it is not a file, it is a Caddy reverse-proxy to Plausible CE
// (Caddyfile :158 rewrites to /js/pa-<hash>.js), already content-addressed upstream AND living
// inside the `<!-- ANALYTICS:START/END -->` region owned by build_analytics.mjs — stamping it
// would fight that injector's --check. A future first-party asset dropped into landing/js/ is
// picked up automatically with no edit here.
//
// NOTE — 3rd injector instance (build_nav.mjs, build_analytics.mjs, this). Per CLAUDE.md's
// 3-example-threshold rule the shared-helper extraction is ACKNOWLEDGED and DEFERRED to
// OPS-SHARED-INJECT-HELPER-EXTRACTION-W{NEXT}, NOT inline-extracted here (build_nav is frozen).
// This one is also structurally simpler than the other two: an attribute rewrite, not a
// marker-region replace, so it shares little with them beyond "walk landing/**/*.html".
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');
export const LANDING_DIR = path.join(REPO_ROOT, 'landing');
export const JS_DIR = path.join(LANDING_DIR, 'js');

/** `src="/js/<name>.js"` with an optional existing `?v=<hex>`. Capture groups: name, version. */
export const ASSET_REF_RE = /(?<=src=")\/js\/([A-Za-z0-9._-]+\.js)(?:\?v=([a-f0-9]+))?(?=")/g;

/** First 8 hex of sha256 — changes iff the bytes change, so --check is stable across deploys. */
export function hashFile(absPath) {
  return createHash('sha256').update(fs.readFileSync(absPath)).digest('hex').slice(0, 8);
}

/** Hashes for every first-party asset under landing/js/. Missing dir -> {} (fail-soft). */
export function assetHashes() {
  if (!fs.existsSync(JS_DIR)) return {};
  const out = {};
  for (const f of fs.readdirSync(JS_DIR)) {
    if (f.endsWith('.js')) out[f] = hashFile(path.join(JS_DIR, f));
  }
  return out;
}

/** Every .html under landing/, recursively. */
export function htmlFiles(dir = LANDING_DIR, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) htmlFiles(full, acc);
    else if (entry.name.endsWith('.html')) acc.push(full);
  }
  return acc;
}

/**
 * Rewrite every first-party asset ref in `html` to carry its current content hash.
 * Refs to files we do not own (no such file in landing/js/) are returned UNCHANGED.
 * Pure — exported so tests can exercise it without touching disk.
 */
export function stampHtml(html, hashes) {
  let changed = 0;
  const out = html.replace(ASSET_REF_RE, (match, name, existing) => {
    const hash = hashes[name];
    if (!hash) return match; // not a first-party asset (e.g. proxied /js/insights.js)
    if (existing === hash) return match;
    changed++;
    return `/js/${name}?v=${hash}`;
  });
  return { out, changed };
}

function main() {
  const check = process.argv.includes('--check');
  const hashes = assetHashes();
  const names = Object.keys(hashes);
  if (names.length === 0) {
    console.log('build_asset_versions: no first-party assets under landing/js/ — nothing to do');
    process.exit(0);
  }

  const drifted = [];
  let written = 0;
  let refs = 0;

  for (const file of htmlFiles()) {
    const src = fs.readFileSync(file, 'utf-8');
    for (const m of src.matchAll(ASSET_REF_RE)) if (hashes[m[1]]) refs++;
    const { out, changed } = stampHtml(src, hashes);
    if (!changed) continue;
    if (check) drifted.push(path.relative(REPO_ROOT, file));
    else {
      fs.writeFileSync(file, out);
      written++;
    }
  }

  const summary = names.map((n) => `${n}=${hashes[n]}`).join(' ');
  if (check) {
    if (drifted.length) {
      console.error('build_asset_versions: DRIFT detected — asset changed but its ?v= did not:');
      for (const f of drifted) console.error(`  ${f}`);
      console.error('Run `node scripts/build_asset_versions.mjs` and commit.');
      console.error(`Expected: ${summary}`);
      process.exit(1);
    }
    console.log(`build_asset_versions: in-sync (--check) — ${refs} refs across landing/**/*.html [${summary}]`);
    process.exit(0);
  }
  console.log(`build_asset_versions: stamped ${refs} refs in ${written} file(s) [${summary}]`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
