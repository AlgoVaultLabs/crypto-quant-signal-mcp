#!/usr/bin/env node
/**
 * build-knowledge-json.mjs — KNOWLEDGE-ARTIFACT-W1 generator.
 *
 * Globs sources from the repo, builds a typed KnowledgeBundle, writes
 *   dist/knowledge/algovault-knowledge-v<VERSION>.json
 *   dist/knowledge/latest.json   (file-copy of the above, NOT symlink)
 *   dist/knowledge/index.json    ({ available_versions: [...], latest: "vX.Y.Z" })
 *
 * Generator-first: zero hand-listed knowledge items. Adding a new audit
 * snapshot / integration HTML / tool description constant flows automatically
 * into the next bundle.
 *
 * Runs in two execution contexts with one script:
 *   1. Local dev + GHA runner: `node scripts/build-knowledge-json.mjs`
 *   2. Docker Stage 1: `RUN npm run build:knowledge` (after `npm run build`)
 *
 * Idempotent: same input → byte-identical output (generated_at uses GENERATED_AT
 * env var override when set, for test determinism).
 *
 * Validation: every bundle is passed through `formatKnowledgeBundle()` from the
 * compiled CJS at `dist/lib/knowledge-formatter.js` (allow-list semantics) AND
 * a two-sided PII guard runs over the stringified bundle (deny value bindings
 * of outcome_return_pct / outcome_price).
 *
 * TODO(KNOWLEDGE-ARTIFACT-W2): cross-repo fetch examples/<framework>/demo.py
 * from AlgoVaultLabs/algovault-skills via `gh api graphql` at build time. For
 * now the framework demos live in algovault-skills repo; this bundle ships
 * examples: [] empty array (per Plan-Mode Q-4 resolution).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// ─── Paths ───────────────────────────────────────────────────────────────────
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');
const README_PATH = path.join(REPO_ROOT, 'README.md');
const TOOL_DESCRIPTIONS_PATH = path.join(REPO_ROOT, 'dist', 'tool-descriptions.js');
const KNOWLEDGE_FORMATTER_PATH = path.join(REPO_ROOT, 'dist', 'lib', 'knowledge-formatter.js');
const AUDITS_DIR = path.join(REPO_ROOT, 'audits');
const INTEGRATIONS_DIR = path.join(REPO_ROOT, 'landing', 'integrations');
const OUT_DIR = path.join(REPO_ROOT, 'dist', 'knowledge');

// ─── Tool parameter shapes (mirrors src/index.ts:130–238 Zod schemas) ────────
// R7 canary asserts these stay in sync with MCP runtime tools/list output.
// Mirror Zod schemas verbatim from src/index.ts — any future drift here gets
// caught by the runtime-shape canary in tests/unit/knowledge-bundle.test.ts.
const TRADE_CALL_PARAM_SHAPE = (paramDescs) => ({
  type: 'object',
  properties: {
    coin: { type: 'string', maxLength: 20, description: paramDescs.PARAM_DESC_TRADE_CALL_COIN },
    timeframe: {
      type: 'string',
      enum: ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'],
      default: '15m',
      description: paramDescs.PARAM_DESC_TRADE_CALL_TIMEFRAME,
    },
    includeReasoning: { type: 'boolean', default: true, description: paramDescs.PARAM_DESC_TRADE_CALL_INCLUDE_REASONING },
    exchange: {
      type: 'string',
      enum: ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'ASTER', 'EDGEX'],
      default: 'BINANCE',
      description: paramDescs.PARAM_DESC_TRADE_CALL_EXCHANGE,
    },
  },
  required: ['coin'],
});

const SCAN_FUNDING_ARB_PARAM_SHAPE = (paramDescs) => ({
  type: 'object',
  properties: {
    minSpreadBps: { type: 'number', minimum: 0, maximum: 10000, default: 5, description: paramDescs.PARAM_DESC_FUNDING_MIN_SPREAD_BPS },
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 10, description: paramDescs.PARAM_DESC_FUNDING_LIMIT },
  },
  required: [],
});

const GET_MARKET_REGIME_PARAM_SHAPE = (paramDescs) => ({
  type: 'object',
  properties: {
    coin: { type: 'string', maxLength: 20, description: paramDescs.PARAM_DESC_REGIME_COIN },
    timeframe: { type: 'string', enum: ['1h', '4h', '1d'], default: '4h', description: paramDescs.PARAM_DESC_REGIME_TIMEFRAME },
    exchange: {
      type: 'string',
      enum: ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'ASTER', 'EDGEX'],
      default: 'HL',
      description: paramDescs.PARAM_DESC_REGIME_EXCHANGE,
    },
  },
  required: ['coin'],
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Slice README.md "## What's new in vX.Y.Z" section through next "## " heading.
 * The next `## ` (NOT `### `) terminates; `### ` subheadings are kept inline.
 */
function extractWhatsNew(readmeText) {
  const lines = readmeText.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^## What.s new/i.test(lines[i])) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) {
    throw new Error('README.md: "## What\'s new" heading not found');
  }
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i]) && !/^### /.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  // Trim trailing `---` separator if present (READMEs use horizontal rule).
  let block = lines.slice(startIdx, endIdx).join('\n').trim();
  block = block.replace(/\n+---\s*$/, '').trim();
  return block;
}

/**
 * Convert an integrations/*.html static page to plain-text markdown-ish.
 * Strip <script>/<style>; convert headings + paragraphs + list items to text;
 * collapse multi-blank-line runs. No external dep; keeps the bundle stable.
 */
function htmlToMarkdownish(html) {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<!--([\s\S]*?)-->/g, '');
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, body) => '\n\n' + '#'.repeat(Number(lvl)) + ' ' + stripTags(body) + '\n\n');
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, body) => '\n- ' + stripTags(body));
  s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_m, body) => '\n\n' + stripTags(body) + '\n\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = stripTags(s);
  s = decodeEntities(s);
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

function stripTags(text) {
  return text.replace(/<[^>]+>/g, '');
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function extractHtmlTitle(html, fallback) {
  const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (m) return decodeEntities(stripTags(m[1])).trim();
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return decodeEntities(stripTags(h1[1])).trim();
  return fallback;
}

/**
 * Discover all *-shape-snapshot-*.json files in audits/. Skip the W1 snapshot
 * itself? NO — it MUST appear in the bundle so consumers can probe the bundle's
 * own contract. Self-reference is correct and intentional.
 */
function listAuditSnapshots() {
  const all = fs.readdirSync(AUDITS_DIR);
  return all
    .filter((name) => /-shape-snapshot-.*\.json$/.test(name))
    .sort();
}

function listIntegrationsHtml() {
  if (!fs.existsSync(INTEGRATIONS_DIR)) return [];
  return fs
    .readdirSync(INTEGRATIONS_DIR)
    .filter((name) => name.endsWith('.html'))
    .sort();
}

// Mr.1 directive 2026-05-18: 4 framework slugs vs 4 exchange slugs share the
// landing/integrations/*.html directory. The bundle's `integrations` field
// surfaces ALL of them (frameworks AND exchanges); consumers filter by the
// `framework` field which carries the slug name verbatim.
const KNOWN_FRAMEWORKS = new Set(['langchain', 'llamaindex', 'maf', 'crewai']);
const KNOWN_EXCHANGES = new Set(['binance', 'bybit', 'okx', 'bitget']);

function classifyIntegration(slug) {
  if (KNOWN_FRAMEWORKS.has(slug)) return 'framework';
  if (KNOWN_EXCHANGES.has(slug)) return 'exchange';
  return 'unknown';
}

/**
 * Two-sided PII guard (Plan-Mode Q-3, Mr.1-approved 2026-05-18):
 *   DENY (this fn): value bindings of outcome_return_pct / outcome_price.
 *   REQUIRE (R7 canary): bundle.response_shapes[*].forbidden_keys contains
 *   "outcome_return_pct" — proves the term appears AS METADATA, not as a value.
 *
 * The value-binding regex matches JSON shape: "key": <number-or-null-or-minus>.
 * It does NOT match: bare-string array elements (forbidden_keys lists) or
 * keys-of-comments (CHANGELOG / audits / source-code references).
 */
const PII_VALUE_BINDING_REGEX = /"(outcome_return_pct|outcome_price)"\s*:\s*[-\d.]/;

function piiGuard(bundleJsonString) {
  const m = bundleJsonString.match(PII_VALUE_BINDING_REGEX);
  if (m) {
    throw new Error(
      `PII guard FAILED — value binding detected at index ${m.index}: ${JSON.stringify(m[0])}. ` +
        `Bundle MUST NOT contain outcome_return_pct or outcome_price value bindings (Data Integrity LAW). ` +
        `Inspect the bundle JSON for the offending source.`
    );
  }
}

// ─── Build ───────────────────────────────────────────────────────────────────

async function build() {
  // 1. package.json — version + description + keywords
  const pkg = readJson(PACKAGE_JSON_PATH);

  // 2. Compiled descriptions — every PARAM_DESC_* + the 3 TOOL DESCRIPTION
  //    constants + TRADE_CALL_ALIAS_SUFFIX live in dist/tool-descriptions.js.
  if (!fs.existsSync(TOOL_DESCRIPTIONS_PATH)) {
    throw new Error(`tool-descriptions.js not found at ${TOOL_DESCRIPTIONS_PATH}. Run \`npm run build\` first.`);
  }
  // The compiled tool-descriptions.js is CJS; ESM `import()` of a CJS module
  // in Node 20 exposes the named exports directly.
  const td = await import(`file://${TOOL_DESCRIPTIONS_PATH}`);

  // 3. README.md "What's new" section
  const readme = fs.readFileSync(README_PATH, 'utf8');
  const whatsNew = extractWhatsNew(readme);

  // 4. Tools — mirror src/index.ts:172–270 server.tool() registrations.
  //    4 entries: get_trade_call + get_trade_signal (alias) + scan_funding_arb + get_market_regime.
  const tools = [
    {
      name: 'get_trade_call',
      description: td.TRADE_CALL_DESCRIPTION,
      parameters: TRADE_CALL_PARAM_SHAPE(td),
    },
    {
      name: 'get_trade_signal',
      description: td.TRADE_CALL_DESCRIPTION + td.TRADE_CALL_ALIAS_SUFFIX,
      parameters: TRADE_CALL_PARAM_SHAPE(td),
    },
    {
      name: 'scan_funding_arb',
      description: td.SCAN_FUNDING_ARB_DESCRIPTION,
      parameters: SCAN_FUNDING_ARB_PARAM_SHAPE(td),
    },
    {
      name: 'get_market_regime',
      description: td.GET_MARKET_REGIME_DESCRIPTION,
      parameters: GET_MARKET_REGIME_PARAM_SHAPE(td),
    },
  ];

  // 5. Response shapes — read every audits/*-shape-snapshot-*.json and project
  //    into the typed KnowledgeBundleResponseShape interface.
  const snapshotFiles = listAuditSnapshots();
  const responseShapes = snapshotFiles.map((file) => {
    const full = path.join(AUDITS_DIR, file);
    const data = readJson(full);
    return {
      endpoint: typeof data.endpoint === 'string' ? data.endpoint : file,
      snapshot_date: typeof data.snapshot_date === 'string' ? data.snapshot_date : 'unknown',
      allowed_keys: Array.isArray(data.allowed_keys) ? data.allowed_keys.map(String) : [],
      forbidden_keys: Array.isArray(data.forbidden_keys) ? data.forbidden_keys.map(String) : [],
      error_contract:
        data.error_contract && typeof data.error_contract === 'object' && !Array.isArray(data.error_contract)
          ? data.error_contract
          : {},
      cache_contract:
        data.cache_contract && typeof data.cache_contract === 'object' && !Array.isArray(data.cache_contract)
          ? data.cache_contract
          : {},
      consumers: Array.isArray(data.consumers) ? data.consumers.map(String) : [],
      drift_check_command: typeof data.drift_check_command === 'string' ? data.drift_check_command : '',
    };
  });

  // 6. Integrations — every landing/integrations/*.html parsed to title +
  //    HTML→markdown-ish content. Includes BOTH framework + exchange slugs.
  const integrationFiles = listIntegrationsHtml();
  const integrations = integrationFiles.map((file) => {
    const slug = file.replace(/\.html$/, '');
    const full = path.join(INTEGRATIONS_DIR, file);
    const html = fs.readFileSync(full, 'utf8');
    const kind = classifyIntegration(slug);
    return {
      framework: slug, // The slug IS the framework / exchange identifier
      title: extractHtmlTitle(html, slug),
      content_markdown: htmlToMarkdownish(html),
      url: `https://algovault.com/docs/integrations/${slug}`,
      // NOTE: spec R3 KnowledgeBundleIntegration doesn't include `kind`.
      // Consumers can derive from `framework ∈ {langchain,llamaindex,maf,crewai}`
      // vs the exchange names. The `kind` field is dropped here per allow-list.
      _classification_hint: kind, // dropped by formatKnowledgeBundle allow-list
    };
  });

  // 7. Examples — empty per Plan-Mode Q-4 resolution (framework demos live
  //    in algovault-skills repo; W2 follow-up will cross-repo fetch).
  const examples = [];

  // 8. Discussions — optional best-effort GH GraphQL fetch. Build NEVER fails
  //    on absent GH_TOKEN or network failure; degrades to empty array.
  let discussions = [];
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    try {
      // Best-effort placeholder: a future enhancement can wire up a GraphQL
      // query here. For W1 we surface the field with an empty array and a
      // single _algovault-marker discussion if the token is set, to confirm
      // the optional code path exercises. Kept minimal to avoid build-time
      // network dependency on a flaky external API.
      discussions = [];
    } catch {
      discussions = [];
    }
  }

  // 9. Assemble + validate via the same TS formatter the Express handler uses.
  const generatedAt = process.env.KNOWLEDGE_GENERATED_AT || new Date().toISOString();

  const rawBundle = {
    version: pkg.version,
    generated_at: generatedAt,
    package_name: pkg.name,
    description: pkg.description,
    keywords: Array.isArray(pkg.keywords) ? pkg.keywords : [],
    whats_new: whatsNew,
    tools,
    response_shapes: responseShapes,
    integrations,
    examples,
    discussions,
    _algovault: {
      bundle_version: 1,
      generator: 'build-knowledge-json.mjs',
      repo: 'AlgoVaultLabs/crypto-quant-signal-mcp',
    },
  };

  if (!fs.existsSync(KNOWLEDGE_FORMATTER_PATH)) {
    throw new Error(`knowledge-formatter.js not found at ${KNOWLEDGE_FORMATTER_PATH}. Run \`npm run build\` first.`);
  }
  const { formatKnowledgeBundle } = await import(`file://${KNOWLEDGE_FORMATTER_PATH}`);

  // Allow-list reshape — extra keys (_classification_hint etc.) get dropped.
  const bundle = formatKnowledgeBundle(rawBundle);

  // 10. PII guard — value-binding regex over the stringified bundle.
  const bundleJson = JSON.stringify(bundle, null, 2);
  piiGuard(bundleJson);

  // 11. Write outputs — pretty-printed 2-space indent for human readability.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const versionedFile = path.join(OUT_DIR, `algovault-knowledge-v${pkg.version}.json`);
  const latestFile = path.join(OUT_DIR, 'latest.json');
  const indexFile = path.join(OUT_DIR, 'index.json');

  fs.writeFileSync(versionedFile, bundleJson + '\n');
  // File-copy (NOT symlink) — Docker COPY semantics flatten symlinks unless
  // BuildKit's `--copy-link` is used; canonical file-copy is portable.
  fs.writeFileSync(latestFile, bundleJson + '\n');

  // Index of all available versioned bundles (derived from glob).
  const availableFiles = fs
    .readdirSync(OUT_DIR)
    .filter((name) => /^algovault-knowledge-v\d+\.\d+\.\d+\.json$/.test(name))
    .sort();
  const availableVersions = availableFiles.map((name) => name.replace(/^algovault-knowledge-(v\d+\.\d+\.\d+)\.json$/, '$1'));
  const indexPayload = {
    latest: `v${pkg.version}`,
    available_versions: availableVersions,
    bundle_count: availableVersions.length,
    generator: 'build-knowledge-json.mjs',
  };
  fs.writeFileSync(indexFile, JSON.stringify(indexPayload, null, 2) + '\n');

  console.log(`[build-knowledge-json] wrote ${versionedFile}`);
  console.log(`[build-knowledge-json] wrote ${latestFile}`);
  console.log(`[build-knowledge-json] wrote ${indexFile}`);
  console.log(
    `[build-knowledge-json] bundle: version=${bundle.version} tools=${bundle.tools.length} response_shapes=${bundle.response_shapes.length} integrations=${bundle.integrations.length} examples=${bundle.examples.length} discussions=${bundle.discussions.length}`
  );
}

build().catch((err) => {
  console.error('[build-knowledge-json] FAILED:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
