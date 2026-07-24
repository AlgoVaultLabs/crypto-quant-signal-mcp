#!/usr/bin/env node
/**
 * emit-venue-slo-tiers.mjs — OPS-LABEL-FRESHNESS-W1 R2.
 *
 * Regenerates / verifies the host-side canary mirror ops/monitoring/venue-slo-tiers.json
 * from the in-image SoT dist/lib/venue-slo-tiers.js (single-derivation). The Python
 * freshness canary reads the JSON on the host; the labeler imports the TS — this keeps
 * the scheduler's and the monitor's tier sets byte-locked.
 *
 *   --check   exit 1 if the committed JSON != serializeTierSot()  (CI + prepublish gate)
 *   --write   regenerate the JSON in place
 *
 * tests/unit/venue-slo-tiers.test.ts ALSO locks TS==JSON in the pre-push suite (dist-free),
 * so a drift is caught even without a build; this script is the regeneration tool + CI gate.
 *
 * Exit codes: 0 in-sync / written; 1 drift (--check); 2 dist missing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const JSON_PATH = path.join(REPO, 'ops', 'monitoring', 'venue-slo-tiers.json');

let mod;
try {
  mod = await import(path.join(REPO, 'dist', 'lib', 'venue-slo-tiers.js'));
} catch (e) {
  console.error(`[emit-venue-slo-tiers] dist not built (run \`npm run build\`): ${e.message}`);
  process.exit(2);
}

const want = mod.serializeTierSot();

if (process.argv.includes('--check')) {
  let have = '';
  try { have = readFileSync(JSON_PATH, 'utf8'); } catch { /* missing → drift */ }
  if (have === want) {
    console.log(`[emit-venue-slo-tiers] in-sync ✅ — majors=[${mod.MAJOR_VENUES.join(',')}] major=${mod.MAJOR_SLO_HOURS}h long-tail=${mod.LONGTAIL_SLO_HOURS}h`);
    process.exit(0);
  }
  console.error('[emit-venue-slo-tiers] DRIFT: ops/monitoring/venue-slo-tiers.json != serializeTierSot() — run `node scripts/emit-venue-slo-tiers.mjs --write`');
  process.exit(1);
}

writeFileSync(JSON_PATH, want);
console.log(`[emit-venue-slo-tiers] wrote ${JSON_PATH}`);
