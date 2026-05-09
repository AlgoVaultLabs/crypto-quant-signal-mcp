#!/usr/bin/env node
/**
 * GEO-W1 C4 — JSON-LD generator + sync canary.
 *
 * Live-fetches /api/performance-public + /api/merkle-batches, renders
 * landing/_jsonld/*.json.template into 5 inline <script type="application/ld+json">
 * blocks (Product / Service / SoftwareApplication / Organization / WebSite),
 * and idempotently strips-and-reinjects them into every landing/*.html.
 *
 * Modes:
 *   node scripts/generate_jsonld.mjs           — WRITE: regenerate + write all files
 *   node scripts/generate_jsonld.mjs --check   — CHECK: compute would-be output;
 *                                                exit 1 if any file drifts.
 *                                                Used as a CI canary in deploy.yml.
 *
 * Per the live-data-template-with-generator-and-canary skill (BINANCE-SKILLS-HUB-
 * SUBMISSION-W1) and Plan Mode D3: developer runs WRITE locally + commits the
 * output; CI runs --check parallel to scripts/build_landing.mjs --check and
 * fail-closes the deploy on drift. No cheerio dep — regex strip-and-inject is
 * byte-stable and idempotent.
 *
 * Preserves any non-AlgoVault JSON-LD blocks (e.g. FAQPage on /faq, DefinedTermSet
 * on /glossary, schema.org/Claim itemtype on hero) by stripping ONLY blocks
 * whose data-algovault-jsonld attribute matches one of the 5 managed schema names.
 *
 * Also strips the legacy inline SoftwareApplication block on landing/index.html
 * (no marker yet, pre-GEO-W1) on first WRITE — replaced by the generator-managed
 * SoftwareApplication with the data-algovault-jsonld="SoftwareApplication" marker.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LANDING_DIR = path.join(REPO_ROOT, 'landing');
const TEMPLATE_DIR = path.join(LANDING_DIR, '_jsonld');

const PERF_URL = 'https://api.algovault.com/api/performance-public';
const MERKLE_URL = 'https://api.algovault.com/api/merkle-batches';

const TEMPLATES = [
  { file: 'product.json.template', name: 'Product' },
  { file: 'service.json.template', name: 'Service' },
  { file: 'application.json.template', name: 'SoftwareApplication' },
  { file: 'organization.json.template', name: 'Organization' },
  { file: 'website.json.template', name: 'WebSite' },
];
const MANAGED_NAMES = TEMPLATES.map(t => t.name);

const FILES_TO_SKIP = new Set([
  // (none currently — all landing/*.html get the 5-block scaffold)
]);

async function fetchLiveData() {
  const fetchJson = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    return res.json();
  };
  const [perf, merkle] = await Promise.all([fetchJson(PERF_URL), fetchJson(MERKLE_URL)]);

  const pfeWrRaw = perf?.overall?.pfeWinRate;
  if (typeof pfeWrRaw !== 'number') throw new Error('overall.pfeWinRate missing or non-numeric');
  const pfeWr = (Math.round(pfeWrRaw * 1000) / 10).toFixed(1); // "90.2"

  const requireInt = (val, key) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) throw new Error(`${key} missing or non-numeric`);
    return String(val);
  };

  return {
    pfe_wr: pfeWr,
    total_calls: requireInt(perf.totalCalls, 'totalCalls'),
    asset_count: requireInt(perf.asset_count, 'asset_count'),
    exchange_count: requireInt(perf.exchange_count, 'exchange_count'),
    timeframe_count: requireInt(perf.timeframe_count, 'timeframe_count'),
    batch_count: String((merkle?.batches ?? []).length),
    period_from: perf?.period?.from ?? '',
    period_to: perf?.period?.to ?? '',
    contract_address: merkle?.contractAddress ?? '',
    chain: merkle?.chain ?? '',
  };
}

function renderTemplate(text, data) {
  return text.replace(/\{\{([a-z_][a-z0-9_]*)\}\}/g, (_, key) => {
    if (!(key in data)) throw new Error(`unknown placeholder: {{${key}}}`);
    return data[key];
  });
}

async function buildBlocks(data) {
  const blocks = [];
  for (const t of TEMPLATES) {
    const tplPath = path.join(TEMPLATE_DIR, t.file);
    const raw = await readFile(tplPath, 'utf-8');
    const rendered = renderTemplate(raw, data).trimEnd();
    JSON.parse(rendered); // validate
    blocks.push({ name: t.name, json: rendered });
  }
  return blocks;
}

// Strip blocks tagged with data-algovault-jsonld="<name>" where <name> is one
// of MANAGED_NAMES. Preserves FAQPage / DefinedTermSet / any non-managed block.
function stripManagedBlocks(html) {
  const namesAlt = MANAGED_NAMES.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(
    `\\n?<script type="application/ld\\+json" data-algovault-jsonld="(?:${namesAlt})">[\\s\\S]*?</script>\\n?`,
    'g'
  );
  return html.replace(pattern, '\n');
}

// Strip the legacy inline SoftwareApplication block on landing/index.html
// (pre-GEO-W1; no data-algovault-jsonld attribute). Identified by the comment
// header + an unmarked <script>. Idempotent: matches once on first WRITE,
// no-ops on subsequent runs.
function stripLegacySoftwareApplication(html) {
  const pattern = /\n?<!-- Structured Data: SoftwareApplication -->\n<script type="application\/ld\+json">[\s\S]*?<\/script>\n?/;
  return html.replace(pattern, '\n');
}

function injectBlocks(html, blocks) {
  const insertion = blocks
    .map(b => `<script type="application/ld+json" data-algovault-jsonld="${b.name}">\n${b.json}\n</script>`)
    .join('\n');
  // Match (and consume) any leading newline run before </head>. This makes the
  // generator byte-idempotent: each stripManaged removal leaves a \n residue,
  // and absorbing all \n preceding </head> normalizes the form to exactly
  // `\n<insertion>\n</head>` regardless of how many residual \n exist.
  return html.replace(/\n+<\/head>/, `\n${insertion}\n</head>`);
}

async function processFile(filepath, blocks) {
  const before = await readFile(filepath, 'utf-8');
  let after = before;
  after = stripLegacySoftwareApplication(after);
  after = stripManagedBlocks(after);
  after = injectBlocks(after, blocks);
  return { before, after };
}

async function main() {
  const checkMode = process.argv.includes('--check');
  const data = await fetchLiveData();
  const blocks = await buildBlocks(data);

  const allFiles = await readdir(LANDING_DIR);
  const htmlFiles = allFiles.filter(f => f.endsWith('.html') && !FILES_TO_SKIP.has(f)).sort();

  let drift = 0;
  let changed = 0;
  for (const f of htmlFiles) {
    const filepath = path.join(LANDING_DIR, f);
    const { before, after } = await processFile(filepath, blocks);
    if (before !== after) {
      if (checkMode) {
        drift++;
        console.error(`DRIFT: ${f} would change (run: node scripts/generate_jsonld.mjs)`);
      } else {
        await writeFile(filepath, after);
        console.log(`UPDATED: ${f}`);
        changed++;
      }
    } else if (!checkMode) {
      console.log(`UNCHANGED: ${f}`);
    }
  }

  if (checkMode) {
    if (drift > 0) {
      console.error(`generate_jsonld --check FAILED — ${drift} file(s) drift. Re-run without --check + commit.`);
      process.exit(1);
    }
    console.log(`generate_jsonld --check OK — all ${htmlFiles.length} landing/*.html files in sync.`);
  } else {
    console.log(`generate_jsonld: done — ${changed}/${htmlFiles.length} file(s) updated. Live snapshot: pfe_wr=${data.pfe_wr}%, total_calls=${data.total_calls}, asset_count=${data.asset_count}, exchange_count=${data.exchange_count}, timeframe_count=${data.timeframe_count}, batch_count=${data.batch_count}.`);
  }
}

main().catch(err => {
  console.error(`generate_jsonld FAILED: ${err.message}`);
  process.exit(2);
});
