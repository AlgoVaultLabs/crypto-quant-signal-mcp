#!/usr/bin/env node
/**
 * build_landing.mjs — inject generated HTML blocks into landing HTML
 * files between named BUILD markers. Targets:
 *
 *   landing/docs.html:
 *     BUILD:signup-flow:start / :end          — renderSignupFlowTailwind()
 *     BUILD:mcp-usage:start    / :end          — MCP_USAGE_HTML
 *
 *   landing/integrations.html (INTEGRATIONS-FULL-STACK-W1 C3):
 *     BUILD:INTEGRATIONS_INDEX_MCP_CLIENTS:start / :end   — renderIndexGrid(MCP_CLIENTS)
 *     BUILD:INTEGRATIONS_INDEX_AI_AGENTS:start    / :end   — renderIndexGrid(AI_AGENTS)
 *     BUILD:INTEGRATIONS_INDEX_EXCHANGE_KITS:start / :end  — renderIndexGrid(EXCHANGE_KITS)
 *
 * Single source of truth lives in src/lib/{signup-flow,mcp-usage-docs,
 * integrations-data/*}.ts; imported here from compiled dist/lib/*.js so
 * `npm run build` (tsc) MUST run before this script. The npm
 * `build:landing` script chains them.
 *
 * Usage:
 *   node scripts/build_landing.mjs           — write if drift, no-op if in-sync
 *   node scripts/build_landing.mjs --check   — exit 1 on drift, 0 if in-sync (CI guard)
 *
 * Idempotent canary: SHA256 hash of new vs current marker block per block.
 * Net result: `files=0` ONLY if every block is in-sync; otherwise `files=N`
 * for the count of files that received writes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// createRequire so default-export CJS modules (compiled by tsc from
// `export default` in .ts) can be loaded as `require(X).default` without
// the ESM-interop double-wrap that `await import()` produces on this
// Node version. See INTEGRATIONS-FULL-STACK-W1 C3 — the data modules
// export default; in `await import(...).default` returns a wrapper, not
// the SurfaceModule. createRequire gets us the raw CJS exports.
const require = createRequire(import.meta.url);

const DOCS_HTML_PATH         = path.join(REPO_ROOT, 'landing', 'docs.html');
const INTEGRATIONS_HTML_PATH = path.join(REPO_ROOT, 'landing', 'integrations.html');
const SIGNUP_FLOW_DIST       = path.join(REPO_ROOT, 'dist', 'lib', 'signup-flow.js');
const MCP_USAGE_DIST         = path.join(REPO_ROOT, 'dist', 'lib', 'mcp-usage-docs.js');
const MCP_CLIENTS_DIST       = path.join(REPO_ROOT, 'dist', 'lib', 'integrations-data', 'mcp-clients.js');
const AI_AGENTS_DIST         = path.join(REPO_ROOT, 'dist', 'lib', 'integrations-data', 'ai-agents.js');
const EXCHANGE_KITS_DIST     = path.join(REPO_ROOT, 'dist', 'lib', 'integrations-data', 'exchange-kits.js');
const RENDER_DIST            = path.join(REPO_ROOT, 'dist', 'lib', 'integrations-data', 'render.js');

const checkMode = process.argv.includes('--check');

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Replace the content between `<!-- BUILD:<name>:start -->` and
 * `<!-- BUILD:<name>:end -->` with `newBlock`, returning {html, inSync}.
 * Throws if markers are missing.
 */
function replaceBlock(html, name, newBlock, filePath) {
  const MARKER_START = `<!-- BUILD:${name}:start -->`;
  const MARKER_END   = `<!-- BUILD:${name}:end -->`;
  const startIdx = html.indexOf(MARKER_START);
  const endIdx = html.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`missing/malformed BUILD:${name} markers in ${filePath}`);
  }
  const before = html.slice(0, startIdx + MARKER_START.length);
  const after = html.slice(endIdx);
  const currentInner = html.slice(startIdx + MARKER_START.length, endIdx);
  // Wrap with surrounding whitespace so the pretty-printed source has a blank
  // line between the marker comment and the injected block (signup-flow
  // historical convention; we keep it for diff readability).
  const newInner = `\n${newBlock}\n      `;
  const inSync = sha256(currentInner) === sha256(newInner);
  return {
    html: inSync ? html : `${before}${newInner}${after}`,
    inSync,
    name,
  };
}

async function processFile(filePath, blocks) {
  let html = fs.readFileSync(filePath, 'utf8');
  let allInSync = true;
  const driftReport = [];
  for (const { name, content } of blocks) {
    const { html: nextHtml, inSync } = replaceBlock(html, name, content, filePath);
    html = nextHtml;
    if (!inSync) {
      allInSync = false;
      driftReport.push(name);
    }
  }
  return { html, allInSync, driftReport };
}

async function main() {
  const required = [
    SIGNUP_FLOW_DIST,
    MCP_USAGE_DIST,
    MCP_CLIENTS_DIST,
    AI_AGENTS_DIST,
    EXCHANGE_KITS_DIST,
    RENDER_DIST,
  ];
  for (const p of required) {
    if (!fs.existsSync(p)) {
      console.error(`build_landing: ${p} not found. Run \`npm run build\` (tsc) first.`);
      process.exit(2);
    }
  }
  for (const p of [DOCS_HTML_PATH, INTEGRATIONS_HTML_PATH]) {
    if (!fs.existsSync(p)) {
      console.error(`build_landing: ${p} not found.`);
      process.exit(2);
    }
  }

  const { renderSignupFlowTailwind } = await import(SIGNUP_FLOW_DIST);
  const { MCP_USAGE_HTML } = await import(MCP_USAGE_DIST);
  // Default-export CJS modules — use createRequire to avoid ESM-interop double-wrap.
  const MCP_CLIENTS = require(MCP_CLIENTS_DIST).default;
  const AI_AGENTS = require(AI_AGENTS_DIST).default;
  const EXCHANGE_KITS = require(EXCHANGE_KITS_DIST).default;
  const { renderIndexGrid } = require(RENDER_DIST);

  // landing/docs.html blocks
  const docsBlocks = [
    { name: 'mcp-usage',   content: MCP_USAGE_HTML },
    { name: 'signup-flow', content: renderSignupFlowTailwind() },
  ];

  // landing/integrations.html blocks (INTEGRATIONS-FULL-STACK-W1 C3)
  const integrationsBlocks = [
    { name: 'INTEGRATIONS_INDEX_MCP_CLIENTS',   content: renderIndexGrid(MCP_CLIENTS) },
    { name: 'INTEGRATIONS_INDEX_AI_AGENTS',     content: renderIndexGrid(AI_AGENTS) },
    { name: 'INTEGRATIONS_INDEX_EXCHANGE_KITS', content: renderIndexGrid(EXCHANGE_KITS) },
  ];

  const targets = [
    { path: DOCS_HTML_PATH, label: 'landing/docs.html', blocks: docsBlocks },
    { path: INTEGRATIONS_HTML_PATH, label: 'landing/integrations.html', blocks: integrationsBlocks },
  ];

  let writes = 0;
  const driftLines = [];
  for (const t of targets) {
    let result;
    try {
      result = await processFile(t.path, t.blocks);
    } catch (e) {
      console.error(`build_landing: ${e.message}`);
      process.exit(2);
    }
    if (!result.allInSync) {
      if (!checkMode) fs.writeFileSync(t.path, result.html, 'utf8');
      driftLines.push(`${t.label} blocks: ${result.driftReport.join(', ')}`);
      writes += 1;
    }
  }

  // NAV-PLATFORM-GENERATOR-W1 CH3: the registry-driven /tools index (a full generated page,
  // not a BUILD-block fill). buildToolsPage() writes/checks landing/tools.html; nav baked via
  // the shared renderSiteNav() (same region build_nav.mjs injects — stays in sync).
  const { buildToolsPage } = await import('./build_tools_page.mjs');
  const toolsRes = buildToolsPage({ check: checkMode }); // writes landing/tools.html itself (unless --check)
  if (toolsRes.drift) {
    driftLines.push(`${toolsRes.file} (registry-driven /tools index)`);
    writes += 1;
  }

  if (checkMode) {
    if (writes === 0) {
      console.log('build_landing: in-sync (--check) — all BUILD blocks across all targets');
      process.exit(0);
    } else {
      console.error(
        `build_landing: DRIFT detected:\n  ${driftLines.join('\n  ')}\n` +
        `Run \`npm run build:landing\` and commit.`
      );
      process.exit(1);
    }
  }

  if (writes === 0) {
    console.log('build_landing: files=0 (idempotent canary green; all BUILD blocks in-sync)');
    return;
  }

  console.log(`build_landing: files=${writes} (updated)\n  ${driftLines.join('\n  ')}`);
}

main().catch((err) => {
  console.error('build_landing: fatal:', err);
  process.exit(2);
});
