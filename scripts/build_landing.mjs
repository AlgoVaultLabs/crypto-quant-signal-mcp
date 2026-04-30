#!/usr/bin/env node
/**
 * build_landing.mjs — inject generated HTML blocks into landing/docs.html
 * between named BUILD markers. Multiple blocks supported:
 *
 *   BUILD:signup-flow:start / :end   — renderSignupFlowTailwind() (welcome wave)
 *   BUILD:mcp-usage:start    / :end   — MCP_USAGE_HTML (FREE-UNLOCK-W1)
 *
 * Single source of truth lives in src/lib/{signup-flow,mcp-usage-docs}.ts;
 * imported here from compiled dist/lib/*.js so `npm run build` (tsc) MUST
 * run before this script. The npm `build:landing` script chains them.
 *
 * Usage:
 *   node scripts/build_landing.mjs           — write if drift, no-op if in-sync
 *   node scripts/build_landing.mjs --check   — exit 1 on drift, 0 if in-sync (CI guard)
 *
 * Idempotent canary: SHA256 hash of new vs current marker block per block.
 * Net result: `files=0` ONLY if every block is in-sync; otherwise `files=1`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const DOCS_HTML_PATH = path.join(REPO_ROOT, 'landing', 'docs.html');
const SIGNUP_FLOW_DIST   = path.join(REPO_ROOT, 'dist', 'lib', 'signup-flow.js');
const MCP_USAGE_DIST     = path.join(REPO_ROOT, 'dist', 'lib', 'mcp-usage-docs.js');

const checkMode = process.argv.includes('--check');

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Replace the content between `<!-- BUILD:<name>:start -->` and
 * `<!-- BUILD:<name>:end -->` with `newBlock`, returning {html, inSync}.
 * Throws if markers are missing.
 */
function replaceBlock(html, name, newBlock) {
  const MARKER_START = `<!-- BUILD:${name}:start -->`;
  const MARKER_END   = `<!-- BUILD:${name}:end -->`;
  const startIdx = html.indexOf(MARKER_START);
  const endIdx = html.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`missing/malformed BUILD:${name} markers in ${DOCS_HTML_PATH}`);
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

async function main() {
  for (const p of [SIGNUP_FLOW_DIST, MCP_USAGE_DIST]) {
    if (!fs.existsSync(p)) {
      console.error(`build_landing: ${p} not found. Run \`npm run build\` (tsc) first.`);
      process.exit(2);
    }
  }
  if (!fs.existsSync(DOCS_HTML_PATH)) {
    console.error(`build_landing: ${DOCS_HTML_PATH} not found.`);
    process.exit(2);
  }

  const { renderSignupFlowTailwind } = await import(SIGNUP_FLOW_DIST);
  const { MCP_USAGE_HTML } = await import(MCP_USAGE_DIST);

  let html = fs.readFileSync(DOCS_HTML_PATH, 'utf8');
  const blocks = [
    { name: 'mcp-usage',   content: MCP_USAGE_HTML },
    { name: 'signup-flow', content: renderSignupFlowTailwind() },
  ];

  let allInSync = true;
  const driftReport = [];
  for (const { name, content } of blocks) {
    try {
      const { html: nextHtml, inSync } = replaceBlock(html, name, content);
      html = nextHtml;
      if (!inSync) {
        allInSync = false;
        driftReport.push(name);
      }
    } catch (e) {
      console.error(`build_landing: ${e.message}`);
      process.exit(2);
    }
  }

  if (checkMode) {
    if (allInSync) {
      console.log('build_landing: in-sync (--check) — all BUILD blocks');
      process.exit(0);
    } else {
      console.error(
        `build_landing: DRIFT detected in BUILD block(s) [${driftReport.join(', ')}]. ` +
        `Run \`npm run build:landing\` and commit.`
      );
      process.exit(1);
    }
  }

  if (allInSync) {
    console.log('build_landing: files=0 (idempotent canary green; all BUILD blocks in-sync)');
    return;
  }

  fs.writeFileSync(DOCS_HTML_PATH, html, 'utf8');
  console.log(`build_landing: files=1 (landing/docs.html updated; blocks: ${driftReport.join(', ')})`);
}

main().catch((err) => {
  console.error('build_landing: fatal:', err);
  process.exit(2);
});
