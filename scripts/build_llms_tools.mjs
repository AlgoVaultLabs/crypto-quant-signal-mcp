#!/usr/bin/env node
/**
 * build_llms_tools.mjs — DOCS-MARKET-REGIME-SCREENER-W1 CH2.
 *
 * Projects the public tool set into the two LLM-facing files, so a newly listed tool reaches
 * them with zero hand edits (the hand lists had already dropped scan_trade_calls):
 *
 *   landing/llms.txt       BUILD:LLMS_TOOLS_LIST — the "MCP tools include …" key fact
 *   landing/llms-full.txt  BUILD:LLMS_FULL_TOOLS — one "### <n>. `<name>`" subsection per tool
 *
 * Membership + order = publicToolEntries() (registry order, `publicListing`). Each subsection =
 * the tool's label + its SERVED description (servedDescription(), the tools/list text) + its
 * /docs link + the hand lines carried from the pre-projection sections (CARRIED_LINES).
 *
 * The algovault-skills generator owns the other BUILD:LLMS_* regions in these two files and
 * replaces only the blocks it names, so neither generator can write the other's region.
 *
 * Invoked by build_landing.mjs right after buildToolsPage(), so `build_landing --check` covers
 * it. Standalone:
 *   node scripts/build_llms_tools.mjs           write if drift
 *   node scripts/build_llms_tools.mjs --check   0 = in sync, 1 = drift, 2 = a region's markers are missing
 * Reads dist/ — `npm run build` (tsc) first, like build_tools_page.mjs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

export const LLMS_TXT = path.join(REPO_ROOT, 'landing', 'llms.txt');
export const LLMS_FULL_TXT = path.join(REPO_ROOT, 'landing', 'llms-full.txt');
export const LIST_BLOCK = 'LLMS_TOOLS_LIST';
export const FULL_BLOCK = 'LLMS_FULL_TOOLS';
const DOCS_URL = 'https://algovault.com/docs';

const q = (v) => `\`"${v}"\``;

/**
 * The hand lines carried forward from the pre-projection llms-full.txt sections (CH2 Req 3:
 * add before remove). Ruling Q2=A keeps ONLY the lines a probe confirmed; the enum values and
 * defaults project from PUBLIC_TOOL_ENUM_PARAMS — the same tools/list-gated declaration /docs
 * renders — so a carried line cannot go stale behind the wire.
 *
 * Dropped, and why (measured 2026-10-22 against live tools/list and the tools' return sites):
 *   · get_trade_call  timeframe "Default 15m"            — the served schema declares no default
 *   · get_trade_call  exchange "BINANCE … default" + 5 venues — no default; 15 venues served
 *   · scan_funding_arb minSpreadBps "default 10"          — served default 5
 *   · scan_funding_arb limit "default 5"                  — served default 10
 *   · scan_funding_arb output {…, annualisedReturn}       — no such field; the venues, spreadBps
 *     and annualizedPct nest under bestArb (src/types.ts FundingArbOpportunity)
 */
export const CARRIED_LINES = Object.freeze({
  get_trade_call: (schema) => {
    const tf = schema.PUBLIC_TOOL_ENUM_PARAMS.get_trade_call.timeframe;
    return [
      '**Input:**',
      '- `coin` (string, required): Asset symbol (e.g. `"BTC"`, `"ETH"`, `"SOL"`)',
      `- \`timeframe\` (enum): ${tf.values.map(q).join(', ')}.${tf.default ? ` Default ${q(tf.default)}.` : ''}`,
      '- `includeReasoning` (bool, default true): Include human-readable reasoning.',
      '',
      '**Output:** Composite verdict per JSON shape above.',
    ];
  },
  get_market_regime: (schema) => {
    const p = schema.PUBLIC_TOOL_ENUM_PARAMS.get_market_regime;
    return [
      '**Input:**',
      '- `coin` (string, required)',
      `- \`timeframe\` (string, default ${q(p.timeframe.default)})`,
      `- \`exchange\` (enum, default ${q(p.exchange.default)})`,
      '',
      `**Output:** Regime classification (${schema.REGIME_LABELS.join(' / ')}) + confidence + underlying metrics + cross-venue funding sentiment + plain-English strategy suggestion.`,
    ];
  },
});

/** The llms.txt key fact: every public tool, registry order, no count. */
export function renderToolsSentence(entries) {
  const names = entries.map((e) => `\`${e.name}\``);
  const list = names.length > 2 ? `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}` : names.join(' and ');
  return `- MCP tools include ${list} (full set via \`tools/list\`).`;
}

/** The llms-full.txt "## The MCP Tools" body: one subsection per public tool. */
export function renderToolsSections(entries, describe, schema) {
  return entries
    .map((e, i) => {
      const description = describe(e.name);
      if (!description) throw new Error(`build_llms_tools: public tool '${e.name}' has no served description`);
      const lines = [
        `### ${i + 1}. \`${e.name}\` — ${e.label}`,
        '',
        description,
        '',
        `**How to use:** ${DOCS_URL}#${e.anchor}`,
      ];
      const carried = CARRIED_LINES[e.name]?.(schema);
      if (carried) lines.push('', ...carried);
      return lines.join('\n');
    })
    .join('\n\n');
}

/**
 * Replace the body between `<!-- BUILD:<name> -->` and `<!-- /BUILD:<name> -->` (the
 * algovault-skills marker form). Bytes outside the markers are never touched.
 * @returns {{ text: string, found: boolean }}
 */
export function fillBlock(text, name, body) {
  const open = `<!-- BUILD:${name} -->`;
  const close = `<!-- /BUILD:${name} -->`;
  const si = text.indexOf(open);
  const ei = text.indexOf(close);
  if (si === -1 || ei === -1 || ei < si) return { text, found: false };
  return { text: `${text.slice(0, si + open.length)}\n${body}\n${text.slice(ei)}`, found: true };
}

function loadInputs() {
  const { publicToolEntries } = require(path.join(REPO_ROOT, 'dist', 'lib', 'nav-manifest.js'));
  const { servedDescription } = require(path.join(REPO_ROOT, 'dist', 'lib', 'feature-registry.js'));
  const schema = require(path.join(REPO_ROOT, 'dist', 'lib', 'tool-param-schema.js'));
  return { entries: publicToolEntries(), describe: servedDescription, schema };
}

/**
 * Project both regions. Writes only on drift, never in check mode.
 * @returns {{ drifted: string[], missing: string[] }} repo-relative paths
 */
export function buildLlmsTools({ check = false, inputs = loadInputs() } = {}) {
  const { entries, describe, schema } = inputs;
  const jobs = [
    { file: LLMS_TXT, block: LIST_BLOCK, body: renderToolsSentence(entries) },
    { file: LLMS_FULL_TXT, block: FULL_BLOCK, body: renderToolsSections(entries, describe, schema) },
  ];
  const drifted = [];
  const missing = [];
  for (const j of jobs) {
    const rel = path.relative(REPO_ROOT, j.file);
    const current = fs.readFileSync(j.file, 'utf8');
    const { text, found } = fillBlock(current, j.block, j.body);
    if (!found) { missing.push(`${rel} (BUILD:${j.block})`); continue; }
    if (text !== current) {
      drifted.push(rel);
      if (!check) fs.writeFileSync(j.file, text, 'utf8');
    }
  }
  return { drifted, missing };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const check = process.argv.includes('--check');
  const { drifted, missing } = buildLlmsTools({ check });
  if (missing.length) {
    console.error(`build_llms_tools: region markers missing: ${missing.join(', ')}`);
    process.exit(2);
  }
  if (check && drifted.length) {
    console.error(`build_llms_tools --check: DRIFT in ${drifted.join(', ')} — run \`npm run build:landing\` and commit.`);
    process.exit(1);
  }
  console.log(`build_llms_tools${check ? ' --check' : ''}: ${drifted.length && !check ? `wrote ${drifted.join(', ')}` : 'in sync'}`);
}
