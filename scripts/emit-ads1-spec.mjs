#!/usr/bin/env node
/**
 * emit-ads1-spec.mjs — EDGE-ADS1-SCORECARD-W1-V2 CH2 (D24).
 *
 * Regenerates / verifies the committed cross-repo contract `ops/ads1-spec.json` from the single source
 * `dist/scripts/ads1/spec.js` (`serializeAds1Spec()`). The autonomous-optimizer repo vendors these exact
 * bytes with a pinned sha256, so the ADS-1 constants cannot drift between the two repos silently.
 *
 *   --check   exit 1 if the committed JSON != serializeAds1Spec()
 *   --write   regenerate the JSON in place
 *
 * tests/unit/ads1-spec-lock.test.ts also locks TS == JSON in the pre-push suite (dist-free), so drift is
 * caught without a build; this script is the regeneration tool.
 *
 * Exit codes: 0 in-sync / written · 1 drift (--check) · 2 dist missing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const JSON_PATH = path.join(REPO, 'ops', 'ads1-spec.json');

let mod;
try {
  mod = await import(path.join(REPO, 'dist', 'scripts', 'ads1', 'spec.js'));
} catch (e) {
  console.error(`[emit-ads1-spec] dist not built (run \`npm run build\`): ${e.message}`);
  process.exit(2);
}
const serialize = mod.serializeAds1Spec ?? mod.default?.serializeAds1Spec;
const want = serialize();
if (process.argv.includes('--write')) {
  writeFileSync(JSON_PATH, want);
  console.log(`[emit-ads1-spec] wrote ${path.relative(REPO, JSON_PATH)} (spec_version ${JSON.parse(want).spec_version})`);
  process.exit(0);
}
let have = '';
try { have = readFileSync(JSON_PATH, 'utf8'); } catch { /* missing → drift */ }
if (have === want) {
  console.log(`[emit-ads1-spec] in-sync — spec_version ${JSON.parse(want).spec_version}`);
  process.exit(0);
}
console.error('[emit-ads1-spec] DRIFT: ops/ads1-spec.json != serializeAds1Spec() — run `node scripts/emit-ads1-spec.mjs --write`');
process.exit(1);
